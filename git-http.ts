// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack
// (ls-refs and fetch, v2 with a v0 fallback) and receive-pack (v0), all
// framed by hand. The wire shapes follow what the suite's client parses:
//   - v0 advertisement: "# service=..." line, flush, ref lines, flush; the
//     first ref line carries the capabilities after a NUL.
//   - v2 advertisement: "version 2" then one capability per line, flush.
//   - v2 fetch answers in sections (acknowledgments, shallow-info,
//     wanted-refs, packfile), separated by delim, ending in flush; the
//     packfile section carries sideband packets (band 1 = pack data).
//   - receive-pack answers report-status, inside sideband band 1 when the
//     client negotiated side-band-64k.

import {
  ZERO_OID,
  computeFetch,
  decodeAllPktLines,
  decodePktLinesUntilFlush,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  pktLinesToStrings,
  readPack,
  writePack,
  type Pkt,
} from './git.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref the repo advertises, HEAD first, then heads, then tags. */
export function listRefs(repo: Repo): GitRef[] {
  const out: GitRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  out.push({
    name: 'HEAD',
    oid: headOid ?? ZERO_OID,
    symrefTarget: defaultRef,
    ...(headOid === undefined ? { unborn: true } : {}),
  });
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) out.push({ name, oid: repo.refs.get(name) as string });
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    const entry: GitRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V0_CAPS = `side-band-64k multi_ack_detailed thin-pack no-progress ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

/** A v0 ref advertisement body for a service. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    // Empty repository: the capabilities^{} pseudo-ref carries the caps.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = refs[0] as GitRef;
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const ref of realRefs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement body (upload-pack only). */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function parseFetchV2(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) request.deepenSince = parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
  return request;
}

function parseFetchV0(packets: readonly Pkt[]): FetchRequest {
  // Two sections split by a flush: wants (+shallow/deepen), then haves + done.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).split(' ');
        request.wants.push(rest[0] as string);
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10);
      else if (line.startsWith('deepen-since ')) request.deepenSince = parseInt(line.slice(13).trim(), 10);
      else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
    }
  }
  return request;
}

/** Sideband packets (band 1) for a pack, chunked to the pkt-line limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte length header,
  // and a sideband packet spends one payload byte on the band: data ≤ 65515.
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function ackFor(repo: Repo, request: FetchRequest): { ack: string | null } {
  // ACK the first have that is an ancestor-or-equal of a want.
  for (const have of request.haves) {
    for (const want of request.wants) {
      if (have === want) return { ack: have };
      const seen = new Set<string>();
      const queue: string[] = [want];
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (oid === have) return { ack: have };
        const object = repo.objects.get(oid);
        if (!object) continue;
        if (object.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        } else if (object.type === 'tag') {
          queue.push(parseTag(object.data).object);
        }
      }
    }
  }
  return { ack: null };
}

export interface GitHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Dispatch one git smart-HTTP request. `tail` is the path after
 * /{owner}/{repo}.git: ['info', 'refs'], ['git-upload-pack'] or
 * ['git-receive-pack']. A missing repo is a JSON 404 and the server stays up.
 */
export function handleGitHttp(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  tail: string[],
  query: Readonly<Record<string, string>>,
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
): GitHttpResponse {
  const json404: GitHttpResponse = {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message: 'Not Found' })),
  };
  const repo = store.findRepo(owner, repoName);
  if (!repo) return json404;
  const isV2 = String(headers['git-protocol'] ?? '').includes('version=2');

  if (tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    const service = query.service ?? '';
    if (service === 'git-upload-pack') {
      if (isV2) {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return json404;
  }
  if (tail[0] === 'git-upload-pack' && method === 'POST') {
    return handleUploadPack(repo, body, isV2);
  }
  if (tail[0] === 'git-receive-pack' && method === 'POST') {
    return handleReceivePack(repo, body);
  }
  return json404;
}

export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): { status: number; contentType: string; body: Buffer } {
  const RESULT_TYPE = 'application/x-git-upload-pack-result';
  try {
    if (isV2) {
      const { packets } = decodePktLinesUntilFlush(body);
      const lines = pktLinesToStrings(packets);
      const command = lines.find((line) => line.startsWith('command='))?.slice(8) ?? '';
      if (command === 'ls-refs') return { status: 200, contentType: RESULT_TYPE, body: handleLsRefs(repo, lines) };
      if (command === 'fetch') return { status: 200, contentType: RESULT_TYPE, body: handleFetchV2(repo, lines) };
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` })) };
    }
    // v0: the first line decides — want lines mean a fetch.
    const packets = decodeAllPktLines(body);
    const lines = pktLinesToStrings(packets);
    if (lines.some((line) => line.startsWith('want '))) {
      return { status: 200, contentType: RESULT_TYPE, body: handleFetchV0(repo, packets) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad request' })) };
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad request' })) };
  }
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      const extra = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      parts.push(pktLine(`unborn ${ref.name}${extra}\n`));
      continue;
    }
    const extra: string[] = [];
    if (symrefs && ref.symrefTarget) extra.push(`symref-target:${ref.symrefTarget}`);
    if (peel && ref.peeled) extra.push(`peeled:${ref.peeled}`);
    parts.push(pktLine(`${ref.oid} ${ref.name}${extra.length ? ` ${extra.join(' ')}` : ''}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function wantedRefsFor(repo: Repo, wants: readonly string[]): Array<{ oid: string; ref: string }> {
  // One entry per want line, resolving the oid to a ref name: real refs
  // first, HEAD last. A clone wants the same tip twice (HEAD and the
  // branch), so it gets both; a fetch of one branch gets only that branch —
  // listing HEAD there makes git die with "unexpected wanted-ref".
  const refs = listRefs(repo);
  const ordered = [...refs.filter((ref) => ref.name !== 'HEAD'), ...refs.filter((ref) => ref.name === 'HEAD')];
  const used = new Set<string>();
  const out: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    const ref = ordered.find((candidate) => !candidate.unborn && candidate.oid === want && !used.has(candidate.name));
    if (ref) {
      used.add(ref.name);
      out.push({ oid: ref.oid, ref: ref.name });
    }
  }
  return out;
}

function buildFetchResponse(repo: Repo, request: FetchRequest, v2: boolean): Buffer {
  const plan = computeFetch(repo.objects.get.bind(repo.objects), request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (v2) {
    // The acknowledgments section exists only when the client sent haves:
    // a have-less fetch goes straight to shallow-info / wanted-refs /
    // packfile (this is what git's own upload-pack does, and its client
    // dies with "expected 'packfile', received 'acknowledgments'" otherwise).
    if (request.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const { ack } = ackFor(repo, request);
      if (ack) {
        parts.push(pktLine(`ACK ${ack}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktDelim());
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    const wanted = wantedRefsFor(repo, request.wants);
    if (wanted.length > 0) {
      parts.push(pktLine('wanted-refs\n'));
      for (const entry of wanted) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // v0: NAK/ACK and shallow lines as plain pkt-lines, then the sideband pack.
  const { ack } = ackFor(repo, request);
  if (request.haves.length > 0 && ack) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const request = parseFetchV2(lines);
  return buildFetchResponse(repo, request, true);
}

function handleFetchV0(repo: Repo, packets: readonly Pkt[]): Buffer {
  const request = parseFetchV0(packets);
  return buildFetchResponse(repo, request, false);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const RESULT_TYPE = 'application/x-git-receive-pack-result';
  try {
    const { packets, offset } = decodePktLinesUntilFlush(body);
    const commands: PushCommand[] = [];
    let sideband = false;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error('bad push command');
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('bad push command oid');
      commands.push({ oldOid, newOid, ref });
    }
    if (commands.length === 0) throw new Error('no push commands');

    // The pack follows the command flush (absent for delete-only pushes).
    const packBytes = body.subarray(offset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes);
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }

    const reportLines: string[] = [];
    if (!unpackOk) {
      reportLines.push(`unpack ${unpackDetail}`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
    } else {
      reportLines.push('unpack ok');
      for (const command of commands) {
        const result = applyPushCommand(repo, command);
        if (result.ok) reportLines.push(`ok ${command.ref}`);
        else reportLines.push(`ng ${command.ref} ${result.reason}`);
      }
    }

    // The report lines, framed as pkt-lines and terminated by a flush, ride
    // inside sideband band 1; the reader on the other end expects that inner
    // flush (EOF instead reads as "the remote end hung up").
    const inner = Buffer.concat([
      ...reportLines.map((line) => pktLine(`${line}\n`)),
      pktFlush(),
    ]);
    let response: Buffer;
    if (sideband) {
      const chunks: Buffer[] = [];
      const CHUNK = 65515; // 4-byte header + 1 band byte + data ≤ 65520
      for (let i = 0; i < inner.length; i += CHUNK) {
        chunks.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(inner.length, i + CHUNK))])));
      }
      chunks.push(pktFlush());
      response = Buffer.concat(chunks);
    } else {
      response = inner;
    }
    return { status: 200, contentType: RESULT_TYPE, body: response };
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad request' })) };
  }
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return { ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const newObject = repo.objects.get(newOid);
  if (!newObject) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current) return { ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  // Update: old must match the current tip, and new must descend from old.
  if (current !== oldOid) return { ok: false, reason: 'non-fast-forward' };
  if (!isFastForward(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  return isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid));
}
