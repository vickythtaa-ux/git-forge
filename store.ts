// The forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels and comments. Everything lives in Maps; nothing is
// written to disk (the trial pod's /bot is read-only). All ids and timestamps
// the forge itself mints are deterministic — a per-store counter, never the
// clock or Math.random — so two runs over the same requests hold the same
// state. The token's owner is the scenario's viewer (scenario.ts), computed
// from the kit's fixed seed, so ownership never depends on request order.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type CommitView,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';

export const FORGE_IDENTITY = 'forge <forge@example.invalid>';
/** Fixed epoch for server-minted commits; a counter keeps them ordered. */
const FORGE_EPOCH_SEC = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  name: string;
  owner: string;
  id: number;
  globalId: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
  commitCache: Map<string, CommitView>;
  treeCache: Map<string, TreeEntry[]>;
}

/** Opaque Relay-style global ids: base64 of a typed key, never the bare number. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  /** Repositories by name. Only the token's owner ever creates one, so names are unique. */
  reposByName = new Map<string, Repo>();
  /** The login the bearer token names. */
  readonly viewerLogin: string = VIEWER_LOGIN;
  readonly viewerId: number = VIEWER_ID;
  /** The bearer token the entry's environment carries ('' when unset: allow all). */
  readonly token: string;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextRepoSeq = 1;
  private nextCreatedSeq = 1;
  private commitSeq = 0;

  constructor(token: string) {
    this.token = token;
  }

  /** Whether a request's Authorization header is the suite's token. */
  isAuthorized(authHeader: string | undefined): boolean {
    if (this.token === '') return true;
    if (!authHeader) return false;
    return authHeader === `Bearer ${this.token}`;
  }

  // ------------------------------------------------------------------ repos

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | null {
    if (this.reposByName.has(name)) return null;
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      name,
      owner: this.viewerLogin,
      id,
      globalId: globalId('Repository', id),
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.nextRepoSeq,
      commitCache: new Map(),
      treeCache: new Map(),
    };
    this.nextRepoSeq += 1;
    this.reposByName.set(name, repo);
    return repo;
  }

  /** A repository by (owner, name): another owner's name is never this token's repo. */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    return repo.owner === owner ? repo : null;
  }

  deleteRepo(repo: Repo): void {
    this.reposByName.delete(repo.name);
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      databaseId: repo.id,
      node_id: repo.globalId,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: this.viewerId, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    };
  }

  // ------------------------------------------------------------- git objects

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  commitOf(repo: Repo, oid: string): CommitView | null {
    const cached = repo.commitCache.get(oid);
    if (cached) return cached;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    repo.commitCache.set(oid, view);
    return view;
  }

  treeOf(repo: Repo, oid: string): TreeEntry[] | null {
    const cached = repo.treeCache.get(oid);
    if (cached) return cached;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    repo.treeCache.set(oid, entries);
    return entries;
  }

  storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** A server-minted commit (contents API, merges): deterministic identity and time. */
  mintCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): string {
    this.commitSeq += 1;
    const stamp = FORGE_EPOCH_SEC + this.commitSeq;
    const ident = `${FORGE_IDENTITY} ${stamp} +0000`;
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, author: ident, committer: ident, message: fields.message });
    return this.storeObject(repo, 'commit', data);
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(repo, oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the nested trees for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      return this.storeObject(repo, 'tree', data);
    };
    return build(root);
  }

  /** The tree oid of the directory at `path` below `treeOid`, or null. */
  treeOidAtPath(repo: Repo, treeOid: string, path: string): string | null {
    if (path === '') return treeOid;
    let current = treeOid;
    for (const part of path.split('/')) {
      const entries = this.treeOf(repo, current);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** Resolve a ref name (branch, tag, HEAD, sha) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref === 'HEAD') {
      const target = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return target ?? null;
    }
    const direct = repo.refs.get(ref);
    if (direct) return direct;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return this.resolveTagTarget(repo, tag);
      return tag;
    }
    return null;
  }

  /** Follow an annotated tag to its commit. */
  resolveTagTarget(repo: Repo, tagOid: string): string | null {
    const object = repo.objects.get(tagOid);
    if (!object) return null;
    if (object.type === 'commit') return tagOid;
    if (object.type !== 'tag') return null;
    const target = parseTag(object.data).object;
    return this.resolveTagTarget(repo, target);
  }

  /** The commit a branch points at, or null when unborn/missing. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Commits reachable from `tip`, newest first (first-parent walk). */
  listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      out.push({ sha: oid, message: commit.message });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // ------------------------------------------------------------- contents

  /**
   * Write (create or update) a file on a branch through the contents API.
   * Returns the new commit and blob oids, or an error string.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
    sha?: string,
  ): { commitSha: string; contentSha: string } | { error: string; status: number } {
    const branchName = branch ?? repo.defaultBranch;
    let currentTip = this.branchTip(repo, branchName);
    if (!currentTip && branchName !== repo.defaultBranch) {
      // Committing on a branch that does not exist yet: start the branch at
      // the default branch tip (the contents route that creates a branch).
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (defaultTip) {
        repo.refs.set(`refs/heads/${branchName}`, defaultTip);
        currentTip = defaultTip;
      }
    }
    let flat = new Map<string, { oid: string; mode: string }>();
    if (currentTip) {
      const commit = this.commitOf(repo, currentTip);
      if (!commit) return { error: 'branch tip is not a commit', status: 422 };
      flat = this.flattenTree(repo, commit.tree);
    }
    const existing = flat.get(path);
    if (existing) {
      if (sha === undefined) return { error: 'sha was not supplied', status: 422 };
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return { error: 'sha does not match the current blob', status: 409 };
    } else if (sha !== undefined) {
      return { error: 'sha was supplied for a file that does not exist', status: 422 };
    }
    const blobOid = this.storeObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const parents = currentTip ? [currentTip] : [];
    const commitSha = this.mintCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Delete a file on the default branch through the contents API. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    sha?: string,
  ): { commitSha: string } | { error: string; status: number } {
    const currentTip = this.branchTip(repo, repo.defaultBranch);
    if (!currentTip) return { error: 'Not Found', status: 404 };
    const commit = this.commitOf(repo, currentTip);
    if (!commit) return { error: 'Not Found', status: 404 };
    const flat = this.flattenTree(repo, commit.tree);
    const existing = flat.get(path);
    if (!existing) return { error: 'Not Found', status: 404 };
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 'sha does not match the current blob', status: 409 };
    }
    flat.delete(path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const commitSha = this.mintCommit(repo, { tree: treeOid, parents: [currentTip], message });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
    return { commitSha };
  }

  /** Read a file or directory from a ref's tree. */
  readContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; sha: string; content: Buffer; size: number; name: string; path: string }
    | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> }
    | null {
    const tip = ref ? this.resolveRef(repo, ref) : this.branchTip(repo, repo.defaultBranch);
    if (!tip) return null;
    const commit = this.commitOf(repo, tip);
    if (!commit) return null;
    const flat = this.flattenTree(repo, commit.tree);
    const file = flat.get(path);
    if (file) {
      const object = repo.objects.get(file.oid);
      if (!object) return null;
      return {
        kind: 'file',
        sha: file.oid,
        content: object.data,
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
      };
    }
    // Directory: entries directly under `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0] as string;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          const dirTree = this.treeOidAtPath(repo, commit.tree, `${prefix}${first}`);
          children.set(first, { type: 'dir', sha: dirTree ?? '' });
        }
      } else {
        children.set(first, { type: 'file', sha: entry.oid });
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, entry]) => ({ type: entry.type, name, path: `${prefix}${name}`, sha: entry.sha }));
    return { kind: 'dir', entries };
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames?: readonly string[]): Issue | { error: string; status: number } {
    const labels: Label[] = [];
    if (labelNames) {
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return { error: `label ${name} does not exist`, status: 422 };
        labels.push(label);
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    const issue: Issue = {
      id,
      globalId: globalId('Issue', repo.id, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.nextCreatedSeq,
    };
    this.nextCreatedSeq += 1;
    repo.issues.set(number, issue);
    return issue;
  }

  issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: issue.globalId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
      user: { login: this.viewerLogin, id: this.viewerId },
      comments: issue.comments.length,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  // ------------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string; status: number } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (!headSha) return { error: `head branch ${head} does not exist`, status: 422 };
    if (!baseSha) return { error: `base branch ${base} does not exist`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === head && existing.base === base) {
        return { error: 'a pull request is already open for this head and base', status: 422 };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    const pull: Pull = {
      id,
      globalId: globalId('PullRequest', repo.id, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextCreatedSeq,
    };
    this.nextCreatedSeq += 1;
    repo.pulls.set(number, pull);
    return pull;
  }

  pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: pull.globalId,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      user: { login: this.viewerLogin, id: this.viewerId },
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  /** Files changed between the merge base and the head (GitHub's pull files view). */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const lookup = this.lookup(repo);
    const baseOid = mergeBase(pull.headSha, pull.baseSha, lookup) ?? pull.baseSha;
    const baseCommit = this.commitOf(repo, baseOid);
    const headCommit = this.commitOf(repo, pull.headSha);
    if (!baseCommit || !headCommit) return [];
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFlat.get(path);
      const after = headFlat.get(path);
      if (!before && after) {
        const data = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (before && !after) {
        const data = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (before && after && before.oid !== after.oid) {
        const oldData = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const diff = lineDiff(oldData, newData);
        out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * sha, or an error string with a status (404 unknown, 405 conflicted, 409
   * already merged).
   */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } | { error: string; status: number } {
    if (pull.state === 'closed') return { error: 'pull request is already closed', status: 409 };
    const baseTip = this.branchTip(repo, pull.base);
    if (!baseTip) return { error: 'base branch does not exist', status: 422 };
    const headCommit = this.commitOf(repo, pull.headSha);
    const baseCommit = this.commitOf(repo, baseTip);
    if (!headCommit || !baseCommit) return { error: 'pull request tip is missing', status: 422 };
    const lookup = this.lookup(repo);
    const baseOid = mergeBase(pull.headSha, baseTip, lookup) ?? baseTip;
    const baseBaseCommit = this.commitOf(repo, baseOid);
    if (!baseBaseCommit) return { error: 'merge base is missing', status: 422 };
    const ancestorFlat = this.flattenTree(repo, baseBaseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    // Three-way merge: a path changed on both sides to different values conflicts.
    const merged = new Map(baseFlat);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path);
      const head = headFlat.get(path);
      const base = baseFlat.get(path);
      const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
      const baseChanged = (base?.oid ?? null) !== (ancestor?.oid ?? null);
      if (headChanged && baseChanged && (head?.oid ?? null) !== (base?.oid ?? null)) {
        return { error: 'merge conflict', status: 405 };
      }
      if (headChanged) {
        if (head) merged.set(path, head);
        else merged.delete(path);
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const sha = this.mintCommit(repo, { tree: treeOid, parents: [baseTip], message });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2026-11-19T00:00:00Z';
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    return { sha, message };
  }

  /** Whether a pull request can merge cleanly (MERGEABLE vs CONFLICTING). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = this.branchTip(repo, pull.base);
    if (!baseTip) return 'UNKNOWN';
    const headCommit = this.commitOf(repo, pull.headSha);
    const baseCommit = this.commitOf(repo, baseTip);
    if (!headCommit || !baseCommit) return 'UNKNOWN';
    const lookup = this.lookup(repo);
    const baseOid = mergeBase(pull.headSha, baseTip, lookup) ?? baseTip;
    const baseBaseCommit = this.commitOf(repo, baseOid);
    if (!baseBaseCommit) return 'UNKNOWN';
    const ancestorFlat = this.flattenTree(repo, baseBaseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path);
      const head = headFlat.get(path);
      const base = baseFlat.get(path);
      const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
      const baseChanged = (base?.oid ?? null) !== (ancestor?.oid ?? null);
      if (headChanged && baseChanged && (head?.oid ?? null) !== (base?.oid ?? null)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Fast-forward check: is `newOid` a descendant of (or equal to) `oldOid`? */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    return isAncestor(oldOid, newOid, this.lookup(repo));
  }
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A rough line diff: lines present in one side but not the other. */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newSet) {
    const missing = count - (oldSet.get(line) ?? 0);
    if (missing > 0) additions += missing;
  }
  for (const [line, count] of oldSet) {
    const missing = count - (newSet.get(line) ?? 0);
    if (missing > 0) deletions += missing;
  }
  // A changed file always counts at least one addition.
  if (additions === 0 && deletions === 0 && !oldData.equals(newData)) additions = 1;
  return { additions, deletions };
}
