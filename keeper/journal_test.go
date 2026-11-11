package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func readAll(t *testing.T, j *journal, from uint64) []record {
	t.Helper()
	var out []record
	var pos readPos
	for {
		recs, err := j.readFrom(from, 4096, &pos)
		if err != nil {
			t.Fatal(err)
		}
		if len(recs) == 0 {
			return out
		}
		out = append(out, recs...)
		from = recs[len(recs)-1].Seq + 1
	}
}

func TestJournalTornTailIsCut(t *testing.T) {
	dir := t.TempDir()
	j, err := openJournal(dir, 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		j.append(kindOut, []byte(fmt.Sprintf("line %d", i)))
	}
	j.close()
	seg := filepath.Join(dir, segName(1))
	fi, _ := os.Stat(seg)
	// A crash in the middle of the last record (power loss after a partial write).
	os.Truncate(seg, fi.Size()-3)
	j, err = openJournal(dir, 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	recs := readAll(t, j, 1)
	if len(recs) != 9 || string(recs[8].Data) != "line 8" {
		t.Fatalf("got %d records", len(recs))
	}
	if s, _ := j.append(kindNote, []byte("after")); s != 10 {
		t.Fatalf("next seq %d", s)
	}
	j.close()
	// A flipped bit is caught by the CRC.
	b, _ := os.ReadFile(seg)
	b[recHead+2] ^= 0xff // inside the first record's data
	os.WriteFile(seg, b, 0o600)
	j, _ = openJournal(dir, 1<<20, 1<<30)
	if first, last := j.bounds(); last != 0 || first != 1 {
		t.Fatalf("corrupt first record kept: %d..%d", first, last)
	}
	j.close()
}

func TestJournalRotationCapAndTruncate(t *testing.T) {
	dir := t.TempDir()
	j, _ := openJournal(dir, 1024, 4096)
	data := bytes.Repeat([]byte("y"), 200)
	for i := 0; i < 100; i++ {
		j.append(kindOut, data)
	}
	first, last := j.bounds()
	if last != 100 || first == 1 {
		t.Fatalf("cap not applied: %d..%d", first, last)
	}
	segs, _ := filepath.Glob(filepath.Join(dir, "*"+segExt))
	var total int64
	for _, s := range segs {
		fi, _ := os.Stat(s)
		total += fi.Size()
	}
	if total > 4096+1024 {
		t.Fatalf("journal is %d bytes", total)
	}
	recs := readAll(t, j, 0)
	if recs[0].Seq != first || recs[len(recs)-1].Seq != 100 {
		t.Fatalf("read %d..%d", recs[0].Seq, recs[len(recs)-1].Seq)
	}
	nf := j.truncate(95)
	if nf <= first || nf > 95 {
		t.Fatalf("truncate gave %d", nf)
	}
	j.close()
	j, _ = openJournal(dir, 1024, 4096)
	if f, l := j.bounds(); f != nf || l != 100 {
		t.Fatalf("reopened %d..%d", f, l)
	}
	j.close()
}

// Reads older than the in-memory tail come from disk, also while appends continue.
func TestJournalReadsFromDiskBeyondRing(t *testing.T) {
	j, _ := openJournal(t.TempDir(), 1<<20, 1<<30)
	defer j.close()
	big := bytes.Repeat([]byte("z"), 64<<10)
	for i := 0; i < 100; i++ { // 6.4 MB: more than the 4 MB ring
		j.append(kindOut, append([]byte(fmt.Sprintf("%03d", i)), big...))
	}
	if j.ring[0].Seq == 1 {
		t.Fatal("ring did not drop old records")
	}
	recs := readAll(t, j, 1)
	if len(recs) != 100 {
		t.Fatalf("got %d", len(recs))
	}
	for i, r := range recs {
		if string(r.Data[:3]) != fmt.Sprintf("%03d", i) || r.Seq != uint64(i+1) {
			t.Fatalf("record %d wrong", i)
		}
	}
}
