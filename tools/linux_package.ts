/**
 * Fixes to the Linux packages `deno desktop` writes (used by tools/build.ts after each Linux build):
 *
 *   .deb       its desktop entries say Name=aib (the package name); the menu should show the app's name. The .deb is rewritten:
 *              ar archive -> data.tar.gz -> each usr/** /*.desktop gets Name=<app name>; everything else is kept byte for byte.
 *   .AppImage  the squashfs has no .DirIcon (file managers and AppImage integrators show it), its root directory has mode 000
 *              (an extracted AppImage is unreadable), and the top-level .desktop lacks StartupWMClass (so docks cannot match the
 *              window to the entry and show a generic icon). The squashfs is rewritten: every data and fragment block is copied as
 *              is, the metadata (inodes, directories, fragment and id tables) is written anew with zstd, and changed files get a
 *              new uncompressed data block. The AppImage runtime (the ELF in front) is kept.
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// ---- desktop entries ---------------------------------------------------------------------------------------------------

/** A desktop entry with Name=<name> and, when wmClass is given and the entry has none, StartupWMClass=<wmClass>. */
export function fixDesktopEntry(
  text: string,
  name: string,
  wmClass?: string,
): string {
  let out = /^Name=.*$/m.test(text) ? text.replace(/^Name=.*$/m, `Name=${name}`) : text;
  if (wmClass && !/^StartupWMClass=/m.test(out)) {
    out = `${out.replace(/\n*$/, '\n')}StartupWMClass=${wmClass}\n`;
  }
  return out;
}

/**
 * The mode an installed file should have, or null to keep its own: an ELF program 0755, an ELF shared library (*.so, *.so.N)
 * 0644, as Debian lays them out. `deno desktop` cross-builds on Windows and writes every file 0644, so the app cannot start.
 */
export function wantedMode(path: string, head: Uint8Array): number | null {
  const elf = head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  if (!elf) return null;
  return /\.so(\.\d+)*$/.test(path) ? 0o644 : 0o755;
}

// ---- .deb (ar + tar.gz) ------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
        new DecompressionStream('gzip'),
      ),
    ).arrayBuffer(),
  );
}
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
        new CompressionStream('gzip'),
      ),
    ).arrayBuffer(),
  );
}

export interface ArMember {
  name: string;
  header: Uint8Array; // the 60-byte header as read
  data: Uint8Array;
}

export function readAr(ar: Uint8Array): ArMember[] {
  if (dec.decode(ar.subarray(0, 8)) !== '!<arch>\n') {
    throw new Error('not an ar archive');
  }
  const out: ArMember[] = [];
  for (let p = 8; p + 60 <= ar.length;) {
    const header = ar.slice(p, p + 60);
    const name = dec.decode(header.subarray(0, 16)).trim().replace(/\/$/, '');
    const size = parseInt(dec.decode(header.subarray(48, 58)).trim(), 10);
    out.push({ name, header, data: ar.slice(p + 60, p + 60 + size) });
    p += 60 + size + (size % 2);
  }
  return out;
}

export function writeAr(members: ArMember[]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode('!<arch>\n')];
  for (const m of members) {
    const header = m.header.slice();
    header.set(enc.encode(String(m.data.length).padEnd(10, ' ')), 48);
    parts.push(header, m.data);
    if (m.data.length % 2) parts.push(enc.encode('\n'));
  }
  return concat(parts);
}

/** Rewrites the regular files of a tar whose (normalised) path passes `want`; every other byte is kept. */
export function editTar(
  tar: Uint8Array,
  want: (path: string) => boolean,
  edit: (path: string, data: Uint8Array) => Uint8Array,
  mode?: (path: string, data: Uint8Array) => number | null,
): {
  tar: Uint8Array;
  edited: string[];
  modes: string[];
} {
  const parts: Uint8Array[] = [];
  const edited: string[] = [];
  const modes: string[] = [];
  const checksum = (header: Uint8Array) => {
    header.fill(0x20, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  };
  let longName: string | null = null;
  let p = 0;
  while (p + 512 <= tar.length) {
    const header = tar.slice(p, p + 512);
    if (header.every((b) => b === 0)) {
      parts.push(tar.slice(p));
      break;
    }
    const field = (o: number, n: number) => dec.decode(header.subarray(o, o + n)).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.slice(p + 512, p + 512 + size);
    const padded = Math.ceil(size / 512) * 512;
    let path = longName ??
      (field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === 'L') longName = dec.decode(body).replace(/\0.*$/s, '');
    if (type === 'x') {
      const m = dec.decode(body).match(/^\d+ path=(.*)$/m);
      if (m) longName = m[1];
    }
    path = path.replace(/^\.\//, '');
    const regular = type === '0' || type === '\0';
    const want_ = regular && mode ? mode(path, body) : null;
    const had = parseInt(field(100, 8).trim() || '0', 8);
    if (want_ !== null && (had & 0o7777) !== want_) {
      header.set(enc.encode((had & ~0o7777 | want_).toString(8).padStart(7, '0') + '\0'), 100);
      checksum(header);
      modes.push(`${path} ${want_.toString(8)}`);
    }
    const data = regular && want(path) ? edit(path, body) : null;
    if (data && (data.length !== body.length || data.some((b, i) => b !== body[i]))) {
      header.set(
        enc.encode(data.length.toString(8).padStart(11, '0') + '\0'),
        124,
      );
      checksum(header);
      const block = new Uint8Array(Math.ceil(data.length / 512) * 512);
      block.set(data);
      parts.push(header, block);
      edited.push(path);
    } else {
      parts.push(header, tar.slice(p + 512, p + 512 + padded));
    }
    p += 512 + padded;
  }
  return { tar: concat(parts), edited, modes };
}

/** Sets Name=<name> in every desktop entry of a .deb and the modes wantedMode asks for (rewritten in place). Returns the changes. */
export async function fixDeb(path: string, name: string): Promise<string[]> {
  const members = readAr(await Deno.readFile(path));
  const data = members.find((m) => m.name.startsWith('data.tar'));
  if (!data) throw new Error(`${path}: no data.tar member`);
  if (data.name !== 'data.tar.gz') {
    throw new Error(
      `${path}: ${data.name} is not supported (only data.tar.gz)`,
    );
  }
  const { tar, edited, modes } = editTar(
    await gunzip(data.data),
    (p) => /^usr\/.*\.desktop$/.test(p),
    (_p, body) => enc.encode(fixDesktopEntry(dec.decode(body), name)),
    (p, body) => wantedMode(p, body.subarray(0, 4)),
  );
  if (!edited.length && !modes.length) return [];
  data.data = await gzip(tar);
  await Deno.writeFile(path, writeAr(members));
  return [...edited, ...modes.map((m) => `mode ${m}`)];
}

// ---- squashfs (AppImage) -----------------------------------------------------------------------------------------------

const META = 8192;
const NONE32 = 0xffffffff;

export interface SqNode {
  name: string;
  kind: 'dir' | 'file' | 'symlink';
  mode: number; // permission bits
  uid: number; // id table indexes
  gid: number;
  mtime: number;
  nlink: number;
  children?: SqNode[];
  blocksStart?: bigint;
  fileSize?: bigint;
  sparse?: bigint;
  fragment?: number;
  fragOffset?: number;
  blockSizes?: number[];
  target?: Uint8Array;
  /** New contents (written as a fresh uncompressed block); replaces blocksStart/fragment/blockSizes. */
  newData?: Uint8Array;
  num?: number;
}

export interface Squashfs {
  superblock: Uint8Array; // the 96 bytes as read
  blockSize: number;
  dataEnd: number; // where the original inode table started: everything before it (superblock, data, fragments) is kept
  fragments: Uint8Array[]; // 16-byte fragment entries
  ids: Uint8Array; // the id table's entries
  root: SqNode;
  image: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), o += p.length;
  return out;
}

function u8(data: Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class MetaReader {
  private cache = new Map<number, { data: Uint8Array; next: number }>();
  constructor(private img: Uint8Array, private start: number) {}
  block(rel: number) {
    let b = this.cache.get(rel);
    if (!b) {
      const p = this.start + rel;
      const h = this.img[p] | (this.img[p + 1] << 8);
      const raw = this.img.subarray(p + 2, p + 2 + (h & 0x7fff));
      b = {
        data: h & 0x8000 ? raw : u8(zstdDecompressSync(raw)),
        next: rel + 2 + (h & 0x7fff),
      };
      this.cache.set(rel, b);
    }
    return b;
  }
  cursor(rel: number, off: number) {
    return {
      take: (n: number): Uint8Array => {
        const parts: Uint8Array[] = [];
        while (n > 0) {
          const b = this.block(rel);
          if (off >= b.data.length) {
            rel = b.next;
            off = 0;
            continue;
          }
          const k = Math.min(n, b.data.length - off);
          parts.push(b.data.subarray(off, off + k));
          off += k;
          n -= k;
        }
        return concat(parts);
      },
    };
  }
}

/** Reads a table stored as metadata blocks whose positions are listed (u64 each) at lookupStart. */
function readLookupTable(
  img: Uint8Array,
  lookupStart: number,
  bytes: number,
): Uint8Array {
  const v = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const parts: Uint8Array[] = [];
  for (let i = 0; i * META < bytes; i++) {
    const at = Number(v.getBigUint64(lookupStart + 8 * i, true));
    parts.push(new MetaReader(img, at).block(0).data);
  }
  return concat(parts).slice(0, bytes);
}

export function readSquashfs(image: Uint8Array): Squashfs {
  const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (v.getUint32(0, true) !== 0x73717368) {
    throw new Error('not a squashfs image');
  }
  if (v.getUint16(20, true) !== 6) {
    throw new Error('only zstd squashfs is supported');
  }
  if (v.getUint16(28, true) !== 4) {
    throw new Error('only squashfs 4.0 is supported');
  }
  if (v.getBigInt64(56, true) !== -1n) {
    throw new Error('squashfs xattrs are not supported');
  }
  const blockSize = v.getUint32(12, true);
  const fragCount = v.getUint32(16, true);
  const idCount = v.getUint16(26, true);
  const rootRef = v.getBigUint64(32, true);
  const idStart = Number(v.getBigUint64(48, true));
  const inodeStart = Number(v.getBigUint64(64, true));
  const dirStart = Number(v.getBigUint64(72, true));
  const fragStart = Number(v.getBigUint64(80, true));
  const inodes = new MetaReader(image, inodeStart);
  const dirs = new MetaReader(image, dirStart);
  const fragTable = fragCount ? readLookupTable(image, fragStart, fragCount * 16) : new Uint8Array();
  const fragments = Array.from(
    { length: fragCount },
    (_, i) => fragTable.slice(16 * i, 16 * i + 16),
  );
  const ids = readLookupTable(image, idStart, idCount * 4);

  const readInode = (ref: bigint, name: string): SqNode => {
    const c = inodes.cursor(Number(ref >> 16n), Number(ref & 0xffffn));
    const h = new DataView(c.take(16).buffer);
    const type = h.getUint16(0, true);
    const node: SqNode = {
      name,
      kind: 'file',
      mode: h.getUint16(2, true),
      uid: h.getUint16(4, true),
      gid: h.getUint16(6, true),
      mtime: h.getUint32(8, true),
      nlink: 1,
    };
    const blockCount = (size: bigint, frag: number) =>
      Number(
        frag === NONE32 ? (size + BigInt(blockSize) - 1n) / BigInt(blockSize) : size / BigInt(blockSize),
      );
    const sizes = (n: number) => {
      const b = new DataView(c.take(4 * n).buffer);
      return Array.from({ length: n }, (_, i) => b.getUint32(4 * i, true));
    };
    let listing: { block: number; offset: number; size: number } | null = null;
    if (type === 1) {
      const d = new DataView(c.take(16).buffer);
      node.kind = 'dir';
      node.nlink = d.getUint32(4, true);
      listing = {
        block: d.getUint32(0, true),
        offset: d.getUint16(10, true),
        size: d.getUint16(8, true),
      };
    } else if (type === 8) {
      const d = new DataView(c.take(24).buffer);
      node.kind = 'dir';
      node.nlink = d.getUint32(0, true);
      listing = {
        block: d.getUint32(8, true),
        offset: d.getUint16(18, true),
        size: d.getUint32(4, true),
      };
      if (d.getUint32(20, true) !== NONE32) {
        throw new Error('squashfs xattrs are not supported');
      }
    } else if (type === 2) {
      const d = new DataView(c.take(16).buffer);
      node.blocksStart = BigInt(d.getUint32(0, true));
      node.fragment = d.getUint32(4, true);
      node.fragOffset = d.getUint32(8, true);
      node.fileSize = BigInt(d.getUint32(12, true));
      node.sparse = 0n;
      node.blockSizes = sizes(blockCount(node.fileSize, node.fragment));
    } else if (type === 9) {
      const d = new DataView(c.take(40).buffer);
      node.blocksStart = d.getBigUint64(0, true);
      node.fileSize = d.getBigUint64(8, true);
      node.sparse = d.getBigUint64(16, true);
      node.nlink = d.getUint32(24, true);
      node.fragment = d.getUint32(28, true);
      node.fragOffset = d.getUint32(32, true);
      if (d.getUint32(36, true) !== NONE32) {
        throw new Error('squashfs xattrs are not supported');
      }
      node.blockSizes = sizes(blockCount(node.fileSize, node.fragment));
    } else if (type === 3) {
      const d = new DataView(c.take(8).buffer);
      node.kind = 'symlink';
      node.nlink = d.getUint32(0, true);
      node.target = c.take(d.getUint32(4, true));
    } else {
      throw new Error(`squashfs inode type ${type} (${name}) is not supported`);
    }
    if (listing) {
      node.children = [];
      const lc = dirs.cursor(listing.block, listing.offset);
      for (let left = listing.size - 3; left > 0;) {
        const hd = new DataView(lc.take(12).buffer);
        const count = hd.getUint32(0, true) + 1;
        const start = hd.getUint32(4, true);
        left -= 12;
        for (let i = 0; i < count; i++) {
          const e = new DataView(lc.take(8).buffer);
          const nameSize = e.getUint16(6, true) + 1;
          const childName = dec.decode(lc.take(nameSize));
          left -= 8 + nameSize;
          node.children.push(
            readInode(
              (BigInt(start) << 16n) | BigInt(e.getUint16(0, true)),
              childName,
            ),
          );
        }
      }
    }
    return node;
  };

  return {
    superblock: image.slice(0, 96),
    blockSize,
    dataEnd: inodeStart,
    fragments,
    ids,
    root: readInode(rootRef, ''),
    image,
  };
}

/** A regular file's contents (data blocks, then its tail in a fragment). */
export function readSqFile(fs: Squashfs, node: SqNode): Uint8Array {
  if (node.newData) return node.newData;
  const size = Number(node.fileSize);
  const parts: Uint8Array[] = [];
  let at = Number(node.blocksStart);
  const unpack = (word: number, pos: number) => {
    const len = word & 0xffffff;
    const raw = fs.image.subarray(pos, pos + len);
    return word & 0x1000000 ? raw : u8(zstdDecompressSync(raw));
  };
  for (const word of node.blockSizes ?? []) {
    if ((word & 0xffffff) === 0) parts.push(new Uint8Array(fs.blockSize));
    else parts.push(unpack(word, at));
    at += word & 0xffffff;
  }
  if (node.fragment !== NONE32 && node.fragment !== undefined) {
    const f = new DataView(fs.fragments[node.fragment].buffer);
    const block = unpack(f.getUint32(8, true), Number(f.getBigUint64(0, true)));
    parts.push(
      block.subarray(
        node.fragOffset!,
        node.fragOffset! + (size % fs.blockSize),
      ),
    );
  }
  return concat(parts).slice(0, size);
}

class MetaWriter {
  private blocks: Uint8Array[] = [];
  private disk = 0;
  private buf: Uint8Array = new Uint8Array(0);
  /** Where the next byte goes: the disk offset of the current block and the offset inside it. */
  pos() {
    return { block: this.disk, offset: this.buf.length };
  }
  write(bytes: Uint8Array) {
    this.buf = concat([this.buf, bytes]);
    while (this.buf.length >= META) {
      this.flush(this.buf.subarray(0, META));
      this.buf = this.buf.slice(META);
    }
  }
  private flush(chunk: Uint8Array) {
    const c = u8(zstdCompressSync(chunk));
    const stored = c.length < chunk.length ? c : chunk;
    const h = new Uint8Array(2);
    new DataView(h.buffer).setUint16(
      0,
      stored === c ? c.length : chunk.length | 0x8000,
      true,
    );
    this.blocks.push(h, stored.slice());
    this.disk += 2 + stored.length;
  }
  /** The table's bytes, and the disk offset (relative to the table) of each block. */
  finish(): Uint8Array {
    if (this.buf.length) this.flush(this.buf), this.buf = new Uint8Array(0);
    return concat(this.blocks);
  }
}

function le(size: number, fill: (v: DataView) => void): Uint8Array {
  const out = new Uint8Array(size);
  fill(new DataView(out.buffer));
  return out;
}

/** The squashfs with its data area kept and its metadata written anew from fs.root. */
export function writeSquashfs(fs: Squashfs): Uint8Array {
  const tail: Uint8Array[] = [];
  let end = fs.dataEnd;
  // New file contents: one uncompressed block each, appended to the data area (a file under one block needs no fragment).
  const fresh = (node: SqNode) => {
    if (node.kind === 'dir') return node.children!.forEach(fresh);
    if (!node.newData) return;
    if (node.newData.length >= fs.blockSize) {
      throw new Error('replacement files must be smaller than one block');
    }
    node.blocksStart = BigInt(end);
    node.fileSize = BigInt(node.newData.length);
    node.sparse = 0n;
    node.fragment = NONE32;
    node.fragOffset = 0;
    node.blockSizes = node.newData.length ? [node.newData.length | 0x1000000] : [];
    tail.push(node.newData);
    end += node.newData.length;
  };
  fresh(fs.root);
  let count = 0;
  const number = (node: SqNode) => {
    node.children?.forEach(number);
    node.num = ++count;
  };
  number(fs.root);
  const inodes = new MetaWriter();
  const dirs = new MetaWriter();
  const header = (node: SqNode, type: number) =>
    le(16, (v) => {
      v.setUint16(0, type, true);
      v.setUint16(2, node.mode & 0o7777, true);
      v.setUint16(4, node.uid, true);
      v.setUint16(6, node.gid, true);
      v.setUint32(8, node.mtime, true);
      v.setUint32(12, node.num!, true);
    });
  const basicType = (
    n: SqNode,
  ) => (n.kind === 'dir' ? 1 : n.kind === 'file' ? 2 : 3);
  const writeNode = (
    node: SqNode,
    parent: number,
  ): { block: number; offset: number } => {
    if (node.kind === 'dir') {
      const kids = [...node.children!].sort((
        a,
        b,
      ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const refs = kids.map((k) => ({ node: k, ...writeNode(k, node.num!) }));
      const at = dirs.pos();
      let size = 0;
      for (let i = 0; i < refs.length;) {
        let j = i;
        while (
          j < refs.length && j - i < 256 && refs[j].block === refs[i].block &&
          Math.abs(refs[j].node.num! - refs[i].node.num!) < 32768
        ) j++;
        const h = le(12, (v) => {
          v.setUint32(0, j - i - 1, true);
          v.setUint32(4, refs[i].block, true);
          v.setUint32(8, refs[i].node.num!, true);
        });
        dirs.write(h);
        size += 12;
        for (const r of refs.slice(i, j)) {
          const name = enc.encode(r.node.name);
          dirs.write(le(8, (v) => {
            v.setUint16(0, r.offset, true);
            v.setInt16(2, r.node.num! - refs[i].node.num!, true);
            v.setUint16(4, basicType(r.node), true);
            v.setUint16(6, name.length - 1, true);
          }));
          dirs.write(name);
          size += 8 + name.length;
        }
        i = j;
      }
      if (size + 3 > 0xffff) {
        throw new Error('directory too large for a basic directory inode');
      }
      const pos = inodes.pos();
      inodes.write(header(node, 1));
      inodes.write(le(16, (v) => {
        v.setUint32(0, at.block, true);
        v.setUint32(4, 2 + kids.filter((k) => k.kind === 'dir').length, true);
        v.setUint16(8, size + 3, true);
        v.setUint16(10, at.offset, true);
        v.setUint32(12, parent, true);
      }));
      return pos;
    }
    const pos = inodes.pos();
    if (node.kind === 'symlink') {
      inodes.write(header(node, 3));
      inodes.write(le(8, (v) => {
        v.setUint32(0, node.nlink, true);
        v.setUint32(4, node.target!.length, true);
      }));
      inodes.write(node.target!);
      return pos;
    }
    const sizes = le(
      4 * node.blockSizes!.length,
      (v) => node.blockSizes!.forEach((s, i) => v.setUint32(4 * i, s, true)),
    );
    const basic = node.nlink === 1 && !node.sparse &&
      node.blocksStart! < 2n ** 32n && node.fileSize! < 2n ** 32n;
    inodes.write(header(node, basic ? 2 : 9));
    inodes.write(
      basic
        ? le(16, (v) => {
          v.setUint32(0, Number(node.blocksStart), true);
          v.setUint32(4, node.fragment!, true);
          v.setUint32(8, node.fragOffset!, true);
          v.setUint32(12, Number(node.fileSize), true);
        })
        : le(40, (v) => {
          v.setBigUint64(0, node.blocksStart!, true);
          v.setBigUint64(8, node.fileSize!, true);
          v.setBigUint64(16, node.sparse ?? 0n, true);
          v.setUint32(24, node.nlink, true);
          v.setUint32(28, node.fragment!, true);
          v.setUint32(32, node.fragOffset!, true);
          v.setUint32(36, NONE32, true);
        }),
    );
    inodes.write(sizes);
    return pos;
  };
  const rootPos = writeNode(fs.root, count + 1);
  const inodeTable = inodes.finish();
  const dirTable = dirs.finish();
  // A table in metadata blocks plus its lookup list of absolute block positions.
  const lookupTable = (entries: Uint8Array, at: number) => {
    const blocks: Uint8Array[] = [];
    const where: number[] = [];
    for (let i = 0; i < entries.length; i += META) {
      const w = new MetaWriter();
      w.write(entries.subarray(i, i + META));
      where.push(at + blocks.reduce((n, b) => n + b.length, 0));
      blocks.push(w.finish());
    }
    const body = concat(blocks);
    const list = le(
      8 * where.length,
      (v) => where.forEach((p, i) => v.setBigUint64(8 * i, BigInt(p), true)),
    );
    return { bytes: concat([body, list]), start: at + body.length };
  };
  const inodeStart = end;
  const dirStart = inodeStart + inodeTable.length;
  const frag = lookupTable(concat(fs.fragments), dirStart + dirTable.length);
  const id = lookupTable(
    fs.ids,
    dirStart + dirTable.length + frag.bytes.length,
  );
  const used = dirStart + dirTable.length + frag.bytes.length + id.bytes.length;
  const sb = fs.image.slice(0, fs.dataEnd);
  const v = new DataView(sb.buffer);
  v.setUint32(4, count, true);
  v.setUint16(24, v.getUint16(24, true) & ~0x80, true); // no export table
  v.setBigUint64(
    32,
    (BigInt(rootPos.block) << 16n) | BigInt(rootPos.offset),
    true,
  );
  v.setBigUint64(40, BigInt(used), true);
  v.setBigUint64(48, BigInt(id.start), true);
  v.setBigUint64(64, BigInt(inodeStart), true);
  v.setBigUint64(72, BigInt(dirStart), true);
  v.setBigUint64(
    80,
    BigInt(fs.fragments.length ? frag.start : -1n & 0xffffffffffffffffn),
    true,
  );
  v.setBigInt64(88, -1n, true);
  const out = concat([sb, ...tail, inodeTable, dirTable, frag.bytes, id.bytes]);
  const padded = new Uint8Array(Math.ceil(out.length / 4096) * 4096);
  padded.set(out);
  return padded;
}

/** Where an AppImage's squashfs starts: right after the runtime ELF's section headers (as the AppImage runtime computes it). */
export function appImageOffset(file: Uint8Array): number {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (v.getUint32(0) !== 0x7f454c46 || file[4] !== 2) {
    throw new Error('not a 64-bit ELF AppImage');
  }
  const offset = Number(v.getBigUint64(0x28, true)) +
    v.getUint16(0x3a, true) * v.getUint16(0x3c, true);
  if (v.getUint32(offset, true) !== 0x73717368) {
    throw new Error('no squashfs after the AppImage runtime');
  }
  return offset;
}

/**
 * Fixes an AppImage in place: root directory 0755, the top-level desktop entry gets Name=<name> and StartupWMClass=<wmClass>,
 * and .DirIcon (a copy of the icon the entry names, sharing its data blocks) is added when missing. Returns what it changed.
 */
export async function fixAppImage(
  path: string,
  name: string,
  wmClass: string,
): Promise<string[]> {
  const file = await Deno.readFile(path);
  const offset = appImageOffset(file);
  const fs = readSquashfs(file.subarray(offset));
  const root = fs.root;
  const changed: string[] = [];
  if ((root.mode & 0o777) !== 0o755) {
    root.mode = 0o755, changed.push('root directory mode 0755');
  }
  const entry = root.children!.find((c) => c.kind === 'file' && c.name === `${name}.desktop`) ??
    root.children!.find((c) => c.kind === 'file' && c.name.endsWith('.desktop'));
  if (!entry) throw new Error(`${path}: no top-level desktop entry`);
  const text = dec.decode(readSqFile(fs, entry));
  const fixed = fixDesktopEntry(text, name, wmClass);
  if (fixed !== text) {
    entry.newData = enc.encode(fixed), changed.push(entry.name);
  }
  const visit = (dir: SqNode, prefix: string) => {
    for (const c of dir.children!) {
      if (c.kind === 'dir') visit(c, `${prefix}${c.name}/`);
      if (c.kind !== 'file' || !c.fileSize) continue;
      const want = wantedMode(c.name, readSqFile(fs, c).subarray(0, 4));
      if (want !== null && (c.mode & 0o7777) !== want) c.mode = want, changed.push(`mode ${prefix}${c.name} ${want.toString(8)}`);
    }
  };
  visit(root, '');
  if (!root.children!.some((c) => c.name === '.DirIcon')) {
    const iconName = text.match(/^Icon=(.*)$/m)?.[1]?.trim() ?? name;
    const icon = root.children!.find((c) => c.kind === 'file' && c.name === `${iconName}.png`);
    if (!icon) throw new Error(`${path}: the icon ${iconName}.png is missing`);
    root.children!.push({ ...icon, name: '.DirIcon', nlink: 1 });
    changed.push(`.DirIcon (from ${icon.name})`);
  }
  if (!changed.length) return changed;
  await Deno.writeFile(
    path,
    concat([file.subarray(0, offset), writeSquashfs(fs)]),
  );
  return changed;
}
