// Git primitives, implemented by hand on the Node 22 standard library only:
// object hashing, pkt-line framing, pack reading and writing (plain objects,
// plus delta application for completeness), tree/commit/tag parsing and
// building, reachability, and the fetch object-selection algorithm (including
// shallow boundaries). No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

// ---------------------------------------------------------------------------
// hashing

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// pkt-line framing

/** Encode one pkt-line (4-hex length prefix + payload). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** A flush packet ("0000"). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** A delimiter packet ("0001"). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt = { kind: 'flush' } | { kind: 'delim' } | { kind: 'data'; payload: Buffer };

/**
 * Decode pkt-lines from `buf` starting at `start`, stopping after the first
 * flush (or at the end of the buffer). Returns the packets and the offset just
 * past the flush, so a caller can treat the remaining bytes as a pack.
 */
export function decodePktLinesUntilFlush(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65524) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, offset: i + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      // response-end; treat as a boundary like a flush for our purposes.
      packets.push({ kind: 'flush' });
      return { packets, offset: i + 4 };
    }
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, offset: i };
}

/** Decode every pkt-line in a buffer (no early stop). */
export function decodeAllPktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65524) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return packets;
}

/** The text lines of data packets, without trailing newlines. */
export function pktLinesToStrings(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// trees, commits, tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const out = `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------------------
// packs

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  let first = (size & 0x0f) | (code << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  const bytes: number[] = [first];
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a pack (v2, plain objects, no deltas) with a trailer checksum. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return expected === actual;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  const first = (byte >> 4) & 0x07;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    next += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset, next };
}

function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] ?? 0)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `offset`, returning the data and the
 * offset just past the stream. Node's inflateSync throws on a truncated
 * stream and ignores trailing bytes, so "it inflates" is monotonic in the
 * end position: false before the stream's true end, true at and after it.
 * An exponential search plus a binary search finds the smallest end that
 * inflates — the true end — and the Adler-32 trailer there is verified.
 */
export function inflateAtSync(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const inflates = (end: number): Buffer | null => {
    if (end > buffer.length) return null;
    try {
      return inflateSync(buffer.subarray(offset, end));
    } catch {
      return null;
    }
  };
  let lo = offset + 2;
  let hi = offset + 2;
  // Exponential search for an end that inflates.
  for (;;) {
    const data = inflates(hi);
    if (data !== null) {
      // Binary-search the smallest inflating end in [lo, hi].
      let a = lo;
      let b = hi;
      let first = hi;
      while (a <= b) {
        const mid = (a + b) >> 1;
        if (inflates(mid) !== null) {
          first = mid;
          b = mid - 1;
        } else {
          a = mid + 1;
        }
      }
      const dataAtFirst = inflates(first) as Buffer;
      if (buffer.readUInt32BE(first - 4) !== adler32(dataAtFirst)) {
        throw new Error('zlib stream Adler-32 mismatch');
      }
      return { data: dataAtFirst, next: first };
    }
    if (hi >= buffer.length) throw new Error('unterminated zlib stream in pack');
    lo = hi + 1;
    hi = Math.min(buffer.length, hi * 2);
  }
}

function readDeltaVarint(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = delta[next] ?? 0;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value, next };
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaVarint(delta, 0);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint(delta, baseSize.next);
  const parts: Buffer[] = [];
  let produced = 0;
  let i = resultSize.next;
  while (i < delta.length) {
    const op = delta[i] ?? 0;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i] ?? 0, i += 1;
      if (op & 0x02) offset |= (delta[i] ?? 0) << 8, i += 1;
      if (op & 0x04) offset |= (delta[i] ?? 0) << 16, i += 1;
      if (op & 0x08) offset |= (delta[i] ?? 0) << 24, i += 1;
      if (op & 0x10) size = delta[i] ?? 0, i += 1;
      if (op & 0x20) size |= (delta[i] ?? 0) << 8, i += 1;
      if (op & 0x40) size |= (delta[i] ?? 0) << 16, i += 1;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  if (produced !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a pack (v2/v3), resolving OFS_DELTA against earlier entries and
 * REF_DELTA against already-read objects. Verifies the trailer checksum.
 */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  if (!verifyPackChecksum(pack)) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = header.first;
    let type: GitObjectType;
    let data: Buffer;
    if (typeCode >= 1 && typeCode <= 4) {
      type = CODE_TYPE[typeCode] as GitObjectType;
      const inflated = inflateAtSync(pack, offset);
      data = inflated.data;
      offset = inflated.next;
      if (data.length !== header.size) throw new Error('pack object size mismatch');
    } else if (typeCode === 6) {
      // OFS_DELTA
      const baseRef = readOfsDeltaBase(pack, offset);
      offset = baseRef.next;
      const baseOffset = entryStart - baseRef.baseOffset;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      const inflated = inflateAtSync(pack, offset);
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      offset = inflated.next;
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const inflated = inflateAtSync(pack, offset);
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      offset = inflated.next;
      deltaCount += 1;
    } else {
      throw new Error(`bad pack entry type ${typeCode}`);
    }
    const oid = hashObject(type, data);
    const object: GitObject = { type, data };
    objects.set(oid, object);
    byOffset.set(entryStart, object);
    if (offset > end) throw new Error('pack entries overrun the trailer');
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// reachability

/** All objects reachable from `roots` (commits, trees, blobs, tags). */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The ancestors of a commit (itself included), newest-first by BFS. */
export function commitAncestors(tip: string, lookup: ObjectLookup): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [{ oid: tip, gen: 0 }];
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; gen: number };
    if (generations.has(current.oid)) continue;
    const object = lookup(current.oid);
    if (!object || object.type !== 'commit') continue;
    generations.set(current.oid, current.gen);
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: current.gen + 1 });
    }
  }
  return generations;
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(descendant, lookup).has(ancestor);
}

/**
 * The merge base of two commits: the common ancestor with the smallest
 * generation from `a` (BFS from `a`, then BFS from `b` until a hit).
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const aAncestors = commitAncestors(a, lookup);
  if (aAncestors.has(b)) return b;
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// fetch object selection

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch of `wants` (with `haves` already held) must send.
 *
 * - Without a depth limit, everything reachable from the wants except what
 *   the client holds.
 * - With `depth`, only commits within `depth` generations of a want (and
 *   their trees/blobs); the shallow boundary is the deepest sent generation.
 * - A held commit's history counts as held, except past a shallow boundary:
 *   the client holds a shallow boundary commit but not its parents, so the
 *   held set stops at boundaries named in `oldShallow`.
 * - A boundary in `oldShallow` whose parent is now sent becomes unshallow.
 */
export function computeFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  const haveSet = new Set(haves);
  const oldShallowSet = new Set(oldShallow);

  // Resolve want tags to their target commits; collect tag objects to send.
  const tagObjects: GitObject[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      if (!haveSet.has(want)) tagObjects.push(object);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') wantCommits.push(target);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      // A want naming a tree/blob directly: send it as-is when not held.
      if (!haveSet.has(want)) tagObjects.push(object);
    }
  }

  // Generations from the want commits (BFS, parents one generation deeper).
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wantCommits.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; gen: number };
    if (generations.has(current.oid)) continue;
    const object = lookup(current.oid);
    if (!object || object.type !== 'commit') continue;
    generations.set(current.oid, current.gen);
    if (depth !== undefined && current.gen + 1 >= depth) continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: current.gen + 1 });
    }
  }

  // Included commits: every reached generation (no depth) or generations < depth.
  const included = new Set<string>();
  for (const [oid, gen] of generations) {
    if (depth === undefined || gen < depth) included.add(oid);
  }

  // Held objects: the closure of the haves, stopping at shallow boundaries
  // (the client holds the boundary commit itself, not its parents).
  const held = new Set<string>();
  {
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (oldShallowSet.has(oid)) continue; // boundary: its tree is held, its parents are not
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  }

  // Objects to send: each included commit (unless held) contributes itself
  // plus its own tree closure. A commit's parents are NOT followed here —
  // they contribute only when they are themselves included (which is exactly
  // what the depth limit controls). Held trees/blobs are skipped: the client
  // already has that exact tree and everything under it.
  const send = new Map<string, GitObject>();
  for (const oid of included) {
    // A commit the client already holds (itself or as an ancestor of a have)
    // contributes nothing: not itself, and its tree is held too.
    if (held.has(oid)) continue;
    const commitObject = lookup(oid);
    if (!commitObject || commitObject.type !== 'commit') continue;
    send.set(oid, commitObject);
    const commit = parseCommit(commitObject.data);
    const treeStack: string[] = [commit.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (held.has(treeOid) || send.has(treeOid)) continue;
      const treeObject = lookup(treeOid);
      if (!treeObject) continue;
      send.set(treeOid, treeObject);
      if (treeObject.type === 'tree') {
        for (const entry of parseTree(treeObject.data)) treeStack.push(entry.oid);
      }
    }
  }
  for (const tag of tagObjects) {
    const oid = hashObject(tag.type, tag.data);
    if (!held.has(oid)) send.set(oid, tag);
  }

  // Order: commits first (shallowest generation first), then the rest.
  const sentCommits = [...send.entries()]
    .filter(([, object]) => object.type === 'commit')
    .sort((a, b) => (generations.get(a[0]) ?? 0) - (generations.get(b[0]) ?? 0));
  const rest = [...send.entries()].filter(([, object]) => object.type !== 'commit');
  const objects = [...sentCommits, ...rest].map(([, object]) => object);

  // Shallow boundary: the deepest sent generation (depth-limited fetches).
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of generations) {
      if (gen === depth - 1 && send.has(oid)) shallow.push(oid);
    }
  }
  // Unshallow: old boundaries whose parent is now sent.
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => send.has(parent))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}
