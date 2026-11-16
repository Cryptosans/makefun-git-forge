// gitcore.ts — git object model, packfiles and pkt-lines for the forge.
// Standard library only: node:crypto for SHA-1, node:zlib for pack streams.
// Every object id is SHA-1 over `<type> <size>\0` + bytes, exactly like git.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 id of an object: SHA-1(`<type> <size>\0` + bytes). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Whether `value` looks like a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Commits, trees, tags: parse and build, byte-exact with git.
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface CommitInput {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  epoch: number;
  message: string;
}

export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  const stamp = `${input.epoch} +0000`;
  lines.push(`author ${input.authorName} <${input.authorEmail}> ${stamp}`);
  lines.push(`committer ${input.committerName} <${input.committerEmail}> ${stamp}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a raw tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries, sorted by git's rule. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

export function buildTag(object: string, type: string, tag: string, taggerName: string, taggerEmail: string, epoch: number, message: string): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${taggerName} <${taggerEmail}> ${epoch} +0000\n\n${msg}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Pkt-lines: git's length-prefixed framing for the smart HTTP protocol.
// ---------------------------------------------------------------------------

/** One pkt-line: 4 hex chars of total length (itself included) + payload. */
export function encodePktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > 65520) throw new Error('pkt-line too large');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/**
 * Parse pkt-lines from the start of `buf` until a flush packet (inclusive).
 * Returns the packets and how many bytes were consumed, so a caller can read
 * the raw pack that follows a flush in a receive-pack request.
 * Throws on malformed framing instead of ever crashing the server.
 */
export function parsePktStream(buf: Buffer): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('pkt-line header is truncated');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') return { packets, consumed: offset + 4 };
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') return { packets, consumed: offset + 4 };
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (offset + length > buf.length) throw new Error('pkt-line body is truncated');
    packets.push({ kind: 'data', data: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
}

/** Parse a whole pkt-line stream (no trailing bytes allowed). */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const { packets, consumed } = parsePktStream(buf);
  if (consumed !== buf.length) throw new Error('trailing bytes after pkt-line stream');
  return packets;
}

// ---------------------------------------------------------------------------
// Packfiles: read (plain objects plus OFS/REF deltas) and write (plain only).
// ---------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; the engine reports how many bytes it consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Read a packfile into objects keyed by id. Every object's SHA-1 is recomputed
 * and its declared size checked. `lookup` supplies objects a thin pack leaves
 * out (the repo's own store); without it a thin pack's delta base is an error.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    try {
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry) {
          const base = resolve(baseEntry);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else if (lookup) {
          const base = lookup(wanted);
          if (!base) throw new Error(`ref-delta base ${wanted} is not in the pack or the store`);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          throw new Error(`ref-delta base ${wanted} is not in the pack`);
        }
      } else {
        type = CODE_TYPE[entry.typeCode]!;
        data = entry.data;
      }
    } finally {
      resolving.delete(entry.offset);
    }
    const oid = hashObject(type, data);
    entry.resolvedType = type;
    entry.resolved = data;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    objects.set(oid, { type, data });
    return { type, data, oid };
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

/** Write a packfile of plain objects (no deltas), ids sorted for determinism. */
/**
 * Deflated object bytes, cached by object id. Objects are content-addressed
 * and immutable, so the same id always deflates to the same bytes — the cache
 * only skips repeated zlib work (a 50-way concurrent clone of one repo
 * deflates each object once instead of 50 times). The pack bytes are
 * identical with or without it, so replay determinism is unaffected.
 */
const deflateCache = new Map<string, Buffer>();

export function writePack(objects: Map<string, GitObject>): Buffer {
  const ids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(ids.length, 8);
  parts.push(head);
  for (const oid of ids) {
    const obj = objects.get(oid)!;
    const typeCode = TYPE_CODE[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    header.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    let deflated = deflateCache.get(oid);
    if (deflated === undefined) {
      deflated = deflateSync(obj.data);
      deflateCache.set(oid, deflated);
    }
    parts.push(deflated);
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability, trees as flat maps, diffs and merges.
// ---------------------------------------------------------------------------

export type ObjectStore = Map<string, GitObject>;

/** Flatten a tree into path -> {oid, mode}, walking subtrees. */
export function flattenTree(objects: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Build tree objects for a flat path map, storing every new tree in `objects`,
 * and return the root tree id. Paths are split on '/'; every file is 100644.
 */
export function buildTreeFromMap(objects: ObjectStore, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: file.mode, name: parts[parts.length - 1]!, oid: file.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** All commit ids reachable from `starts` (following parents; tags unwrap to their target). */
export function reachableCommits(objects: ObjectStore, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...starts];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target !== '') queue.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

/** Every object id reachable from `starts` (commits, trees, blobs, tags). Commits in `stopAt` contribute themselves and their trees, but their parents are not followed: a shallow boundary the client already holds. */
export function reachableObjects(objects: ObjectStore, starts: string[], stopAt: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const visitObject = (oid: string): void => {
    if (seen.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    seen.add(oid);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      visitObject(parsed.tree);
      if (!stopAt.has(oid)) {
        for (const parent of parsed.parents) visitObject(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) visitObject(entry.oid);
    } else if (obj.type === 'tag') {
      visitObject(parseTag(obj.data).object);
    }
  };
  for (const start of starts) visitObject(start);
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(objects: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(objects, [descendant]).has(ancestor);
}

/** The first common ancestor of two commits (breadth-first from both sides). */
export function mergeBase(objects: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = reachableCommits(objects, [a]);
  if (fromA.has(b)) return b;
  const seen = new Set<string>([b]);
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (fromA.has(parent)) return parent;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

export interface FetchSelection {
  /** Objects to send, keyed by id. */
  objects: Map<string, GitObject>;
  /** New shallow boundary commits (at exactly the depth limit). */
  shallow: string[];
  /** Old boundaries whose parents are now all sent. */
  unshallow: string[];
  /** Commit ids the client already holds that are ancestors of the wants. */
  acks: string[];
}

/**
 * Work out a v2 fetch: which objects to send for `wants`, given the client's
 * `haves` and its current shallow boundaries, with an optional `depth` limit.
 * Commits are walked by distance from the wants (want = distance 1); with a
 * depth the walk stops there, and the boundary commits are the new shallow set.
 * Anything reachable from a have is never re-sent.
 */
export function selectFetch(objects: ObjectStore, wants: string[], haves: string[], oldShallow: string[], depth?: number): FetchSelection {
  // Distance of every commit from the nearest want, following parents.
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target !== '' && !distance.has(target)) {
        distance.set(target, 1);
        queue.push({ oid: target, dist: 1 });
      }
      distance.set(want, 1);
    } else if (obj.type === 'commit' && !distance.has(want)) {
      distance.set(want, 1);
      queue.push({ oid: want, dist: 1 });
    }
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, dist } = queue[head++]!;
    if (depth !== undefined && dist >= depth) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push({ oid: parent, dist: dist + 1 });
      }
    }
  }

  // The client's held set: everything reachable from its haves, stopping at
  // its shallow boundaries (a boundary commit's tree is held, its parents are
  // not — they are exactly what a deepen has to deliver). Walking straight
  // through a boundary would treat the parent as held and never send it.
  const haveClosure = reachableObjects(objects, haves, new Set(oldShallow));
  const send = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (haveClosure.has(oid) || send.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    send.set(oid, obj);
  };
  // Tag wants themselves are always sent (unless held).
  for (const want of wants) {
    const obj = objects.get(want);
    if (obj && obj.type === 'tag') addObject(want);
  }
  // Every commit within the walk, with its tree closure.
  for (const [oid, dist] of distance) {
    if (depth !== undefined && dist > depth) continue;
    addObject(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    const flat = flattenTree(objects, tree);
    addObject(tree);
    for (const file of flat.values()) addObject(file.oid);
    // Subtrees of the tip tree (flattenTree already visited them, but add ids).
    const visitTree = (treeOid: string): void => {
      addObject(treeOid);
      const treeObj = objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') visitTree(entry.oid);
      }
    };
    visitTree(tree);
  }

  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, dist] of distance) {
      if (dist === depth && send.has(oid)) shallow.push(oid);
    }
    shallow.sort();
  }
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    const dist = distance.get(boundary);
    if (dist === undefined) continue;
    if (depth === undefined || dist < depth) unshallow.push(boundary);
  }
  unshallow.sort();

  const wantCommits = reachableCommits(objects, wants);
  const acks = haves.filter((have) => objects.has(have) && (wantCommits.has(have) || wants.includes(have))).sort();
  return { objects: send, shallow, unshallow, acks };
}

export interface FileChange {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (null = empty tree): added/deleted/modified files, paths sorted. */
export function diffTrees(objects: ObjectStore, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(objects, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(objects, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'deleted', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/**
 * Three-way merge at file level: base tree, ours, theirs. Returns the merged
 * flat map plus the paths that conflict (changed on both sides differently).
 */
export function threeWayMerge(
  objects: ObjectStore,
  baseTreeOid: string | null,
  oursTreeOid: string | null,
  theirsTreeOid: string | null,
): { merged: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const base = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(objects, baseTreeOid);
  const ours = oursTreeOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(objects, oursTreeOid);
  const theirs = theirsTreeOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(objects, theirsTreeOid);
  const merged = new Map<string, { oid: string; mode: string }>(ours);
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const oursChanged = (o?.oid ?? null) !== (b?.oid ?? null);
    const theirsChanged = (t?.oid ?? null) !== (b?.oid ?? null);
    if (theirsChanged && oursChanged) {
      if ((t?.oid ?? null) !== (o?.oid ?? null)) conflicts.push(path);
    } else if (theirsChanged) {
      if (t) merged.set(path, t);
      else merged.delete(path);
    }
  }
  conflicts.sort();
  return { merged, conflicts };
}

/** Line counts of a blob (for additions/deletions on a changed file). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}
