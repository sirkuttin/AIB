package main

// The journal: one append-only record of a channel, in segments <dir>/<firstSeq>.journal.
//
// Record: [u32le dataLength][u8 kind][u64le seq][u64le timeMs][data][u32le crc32(kind..data)]
//
// Appends go through a buffer that the keeper flushes (and fsyncs) every ~200 ms. The last ~4 MiB of records are also kept in
// memory, so a live reader never waits for a flush. A segment rotates at segBytes; when the channel's segments together pass
// maxBytes the oldest whole segment goes (a runaway agent cannot fill the disk). Otherwise only the client's truncate removes
// anything.

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	recHead  = 4 + 1 + 8 + 8
	recTail  = 4
	ringMax  = 4 << 20
	readMax  = 1 << 20
	segExt   = ".journal"
	nameDigs = 20
)

type record struct {
	Kind kind
	Seq  uint64
	Time int64
	Data []byte
}

func (r *record) size() int { return recHead + len(r.Data) + recTail }

func encodeRecord(dst []byte, r *record) []byte {
	start := len(dst)
	dst = binary.LittleEndian.AppendUint32(dst, uint32(len(r.Data)))
	dst = append(dst, byte(r.Kind))
	dst = binary.LittleEndian.AppendUint64(dst, r.Seq)
	dst = binary.LittleEndian.AppendUint64(dst, uint64(r.Time))
	dst = append(dst, r.Data...)
	return binary.LittleEndian.AppendUint32(dst, crc32.ChecksumIEEE(dst[start+4:]))
}

// decodeRecord reads one record. io.EOF only at a clean boundary; a torn or corrupt record gives errCorrupt.
var errCorrupt = errors.New("corrupt record")

func decodeRecord(r *bufio.Reader, skipData bool) (record, int, error) {
	var h [recHead]byte
	n, err := io.ReadFull(r, h[:])
	if err == io.EOF {
		return record{}, 0, io.EOF
	}
	if err != nil {
		return record{}, n, errCorrupt
	}
	dl := binary.LittleEndian.Uint32(h[0:4])
	if dl > maxBody {
		return record{}, n, errCorrupt
	}
	rec := record{Kind: kind(h[4]), Seq: binary.LittleEndian.Uint64(h[5:13]), Time: int64(binary.LittleEndian.Uint64(h[13:21]))}
	crc := crc32.NewIEEE()
	crc.Write(h[4:])
	data := make([]byte, dl)
	if _, err := io.ReadFull(r, data); err != nil {
		return record{}, n, errCorrupt
	}
	crc.Write(data)
	var t [4]byte
	if _, err := io.ReadFull(r, t[:]); err != nil {
		return record{}, n, errCorrupt
	}
	if binary.LittleEndian.Uint32(t[:]) != crc.Sum32() {
		return record{}, n, errCorrupt
	}
	if !skipData {
		rec.Data = data
	}
	return rec, recHead + int(dl) + recTail, nil
}

type segment struct {
	first uint64
	path  string
	size  int64
}

type journal struct {
	dir      string
	segBytes int64
	maxBytes int64

	mu        sync.Mutex
	segs      []segment // oldest first; the last one is active
	f         *os.File
	w         *bufio.Writer
	next      uint64 // seq of the next record
	first     uint64 // oldest seq still stored
	dirty     bool   // written since the last fsync
	ring      []record
	ringBytes int
	notify    chan struct{} // closed and replaced on every append
	closed    bool
	scratch   []byte
}

func segName(first uint64) string { return fmt.Sprintf("%0*d%s", nameDigs, first, segExt) }

// openJournal opens (or creates) a channel journal and repairs a torn tail left by a crash or power loss.
func openJournal(dir string, segBytes, maxBytes int64) (*journal, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	j := &journal{dir: dir, segBytes: segBytes, maxBytes: maxBytes, next: 1, first: 1, notify: make(chan struct{})}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var segs []segment
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, segExt) {
			continue
		}
		first, err := strconv.ParseUint(strings.TrimSuffix(name, segExt), 10, 64)
		if err != nil || first == 0 {
			continue
		}
		segs = append(segs, segment{first: first, path: filepath.Join(dir, name)})
	}
	sort.Slice(segs, func(a, b int) bool { return segs[a].first < segs[b].first })
	// Scan every segment: records must be contiguous. At the first problem, cut the file there and drop later segments.
	expect := uint64(0)
	for i := 0; i < len(segs); i++ {
		s := &segs[i]
		if expect != 0 && s.first != expect {
			for _, gone := range segs[i:] {
				os.Remove(gone.path)
			}
			segs = segs[:i]
			break
		}
		good, last, err := scanSegment(s.path, s.first)
		if err != nil {
			return nil, err
		}
		s.size = good
		if last != 0 {
			expect = last + 1
		} else {
			expect = s.first
		}
		if fi, err := os.Stat(s.path); err == nil && fi.Size() != good {
			if err := os.Truncate(s.path, good); err != nil {
				return nil, err
			}
			for _, gone := range segs[i+1:] {
				os.Remove(gone.path)
			}
			segs = segs[:i+1]
			break
		}
	}
	if len(segs) == 0 {
		segs = []segment{{first: 1, path: filepath.Join(dir, segName(1))}}
		expect = 1
	}
	j.segs = segs
	j.first = segs[0].first
	j.next = expect
	active := &j.segs[len(j.segs)-1]
	f, err := os.OpenFile(active.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	j.f = f
	j.w = bufio.NewWriterSize(f, 256<<10)
	return j, nil
}

// scanSegment returns the length of the valid prefix of a segment and the last good seq (0 if none).
func scanSegment(path string, first uint64) (int64, uint64, error) {
	f, err := openShared(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 256<<10)
	var good int64
	var last uint64
	want := first
	for {
		rec, n, err := decodeRecord(br, true)
		if err != nil || rec.Seq != want {
			return good, last, nil
		}
		good += int64(n)
		last = rec.Seq
		want++
	}
}

// append adds one record and returns its seq.
func (j *journal) append(k kind, data []byte) (uint64, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return 0, errors.New("journal closed")
	}
	rec := record{Kind: k, Seq: j.next, Time: time.Now().UnixMilli(), Data: append([]byte(nil), data...)}
	size := int64(rec.size())
	active := &j.segs[len(j.segs)-1]
	if active.size > 0 && active.size+size > j.segBytes {
		if err := j.rotateLocked(); err != nil {
			return 0, err
		}
		active = &j.segs[len(j.segs)-1]
	}
	j.scratch = encodeRecord(j.scratch[:0], &rec)
	if _, err := j.w.Write(j.scratch); err != nil {
		return 0, err
	}
	active.size += size
	j.next++
	j.dirty = true
	j.ring = append(j.ring, rec)
	j.ringBytes += rec.size()
	for j.ringBytes > ringMax && len(j.ring) > 1 {
		j.ringBytes -= j.ring[0].size()
		j.ring[0] = record{}
		j.ring = j.ring[1:]
	}
	if cap(j.ring) > 4*len(j.ring)+1024 { // do not keep a large backing array alive
		j.ring = append([]record(nil), j.ring...)
	}
	close(j.notify)
	j.notify = make(chan struct{})
	return rec.Seq, nil
}

func (j *journal) rotateLocked() error {
	if err := j.w.Flush(); err != nil {
		return err
	}
	j.f.Sync()
	j.f.Close()
	s := segment{first: j.next, path: filepath.Join(j.dir, segName(j.next))}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	j.f = f
	j.w.Reset(f)
	j.segs = append(j.segs, s)
	var total int64
	for _, s := range j.segs {
		total += s.size
	}
	for total > j.maxBytes && len(j.segs) > 1 {
		total -= j.segs[0].size
		j.removeOldestLocked()
	}
	return nil
}

func (j *journal) removeOldestLocked() {
	os.Remove(j.segs[0].path)
	j.segs = j.segs[1:]
	j.first = j.segs[0].first
}

// flush writes buffered records to the file, and fsyncs when sync is set and anything was written since the last fsync.
func (j *journal) flush(sync bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.flushLocked(sync)
}

func (j *journal) flushLocked(sync bool) {
	if j.closed {
		return
	}
	j.w.Flush()
	if sync && j.dirty {
		j.f.Sync()
		j.dirty = false
	}
}

// truncate removes whole segments whose records are all older than before. It returns the oldest seq still stored.
func (j *journal) truncate(before uint64) uint64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	for len(j.segs) > 1 && j.segs[1].first <= before {
		j.removeOldestLocked()
	}
	return j.first
}

func (j *journal) bounds() (first, last uint64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.first, j.next - 1
}

// wait returns a channel closed at the next append.
func (j *journal) wait() <-chan struct{} {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.notify
}

func (j *journal) close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	j.w.Flush()
	j.f.Sync()
	j.f.Close()
	j.closed = true
	close(j.notify)
	j.notify = make(chan struct{})
}

// remove closes the journal and deletes its files.
func (j *journal) remove() {
	j.close()
	os.RemoveAll(j.dir)
}

// readPos remembers where a sequential reader stopped, so the next read does not rescan the segment.
type readPos struct {
	seg uint64
	off int64
	seq uint64
}

// readFrom returns records from seq on (or from the oldest stored one, if seq is older), at most about max bytes but always
// at least one record if any exists.
func (j *journal) readFrom(seq uint64, max int, pos *readPos) ([]record, error) {
	j.mu.Lock()
	if seq < j.first {
		seq = j.first
	}
	if seq >= j.next {
		j.mu.Unlock()
		return nil, nil
	}
	if len(j.ring) > 0 && seq >= j.ring[0].Seq {
		i := int(seq - j.ring[0].Seq)
		var out []record
		total := 0
		for ; i < len(j.ring) && (len(out) == 0 || total+j.ring[i].size() <= max); i++ {
			out = append(out, j.ring[i])
			total += j.ring[i].size()
		}
		j.mu.Unlock()
		return out, nil
	}
	j.flushLocked(false)
	segs := append([]segment(nil), j.segs...)
	limit := j.next
	j.mu.Unlock()

	k := sort.Search(len(segs), func(i int) bool { return segs[i].first > seq }) - 1
	if k < 0 {
		k = 0
	}
	var out []record
	total := 0
	for ; k < len(segs) && seq < limit; k++ {
		f, err := openShared(segs[k].path)
		if err != nil {
			return out, err // removed under us (truncate): the caller retries from the new first seq
		}
		var off int64
		if pos != nil && pos.seg == segs[k].first && pos.seq == seq {
			off = pos.off
		}
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			f.Close()
			return out, err
		}
		br := bufio.NewReaderSize(f, 256<<10)
		for seq < limit {
			rec, n, err := decodeRecord(br, false)
			if err != nil {
				break // end of this segment
			}
			off += int64(n)
			if rec.Seq < seq {
				continue
			}
			if rec.Seq != seq {
				break
			}
			if len(out) > 0 && total+rec.size() > max {
				f.Close()
				return out, nil
			}
			out = append(out, rec)
			total += rec.size()
			seq++
			if pos != nil {
				*pos = readPos{seg: segs[k].first, off: off, seq: seq}
			}
		}
		f.Close()
		if len(out) > 0 && total >= max {
			break
		}
	}
	return out, nil
}
