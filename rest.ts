// GitHub REST v3, under /api/v3. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry {"message": string}; unknown
// routes are a JSON 404; malformed JSON bodies are a 400 (the body parser in
// app.ts answers those before dispatch). Authentication is decided in app.ts:
// a missing or wrong Bearer token is a 401 before any handler runs.

import { globalId, type Repo, type Store } from './store.ts';

export interface RestContext {
  store: Store;
  /** The entry's own origin, for absolute Link headers. */
  origin: string;
}

export interface RestResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(json: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, json, headers };
}

function err(message: string, status: number): RestResponse {
  return { status, json: { message } };
}

function notFound(what = 'Not Found'): RestResponse {
  return err(what, 404);
}

function parseIntQuery(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Page {
  page: number;
  perPage: number;
}

/** Paginate an array; returns the page and a Link header when a next page exists. */
function paginate<T>(items: readonly T[], query: Readonly<Record<string, string>>, basePath: string, origin: string): { items: T[]; link: string | null } {
  const page = Math.max(1, parseIntQuery(query.page, 1));
  const perPage = Math.min(100, Math.max(1, parseIntQuery(query.per_page, 30)));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    link = `<${origin}${basePath}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return { items: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: Readonly<Record<string, string>>,
  body: unknown,
): RestResponse {
  const store = ctx.store;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  const [first, second, third] = segments;

  if (first === 'meta') {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0' });
  }

  if (first === 'user') {
    if (second === undefined) {
      if (method !== 'GET') return notFound();
      return ok({
        login: store.viewerLogin,
        id: store.viewerId,
        type: 'User',
        name: store.viewerLogin,
        email: `${store.viewerLogin}@example.invalid`,
      });
    }
    if (second === 'repos') {
      if (method === 'GET') {
        const repos = store.listRepos().map((repo) => store.repoJson(repo));
        const page = paginate(repos, query, '/api/v3/user/repos', ctx.origin);
        return ok(page.items, 200, linkHeaders(page.link));
      }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          return err('name is required', 422);
        }
        const name = body.name as string;
        const repo = store.createRepo(name, {
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true,
        });
        if (!repo) return err(`Repository ${store.viewerLogin}/${name} already exists`, 422);
        return ok(store.repoJson(repo), 201);
      }
      return notFound();
    }
    return notFound();
  }

  if (first !== 'repos' || second === undefined || third === undefined) return notFound();
  const owner = decodeURIComponent(second);
  const repoName = decodeURIComponent(third);
  const repo = store.findRepo(owner, repoName);
  const rest = segments.slice(3);

  // /repos/{owner}/{repo} itself.
  if (rest.length === 0) {
    if (!repo) return notFound();
    if (method === 'GET') return ok(store.repoJson(repo));
    if (method === 'PATCH') {
      if (!isRecord(body)) return err('body must be an object', 400);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return ok(store.repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, json: null };
    }
    return notFound();
  }

  const [sub, ...tail] = rest as [string, ...string[]];

  // Branches.
  if (sub === 'branches') {
    if (!repo) return notFound();
    if (tail.length === 0) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string } }));
      return ok(branches);
    }
    if (tail.length === 1 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[0] as string)}`);
      if (!sha) return notFound();
      return ok({ name: tail[0], commit: { sha } });
    }
    return notFound();
  }

  // Git Data: refs.
  if (sub === 'git' && tail[0] === 'refs') {
    if (!repo) return notFound();
    if (method === 'POST' && tail.length === 1) {
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        return err('ref and sha are required', 422);
      }
      const ref = body.ref as string;
      const sha = body.sha as string;
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err('ref must start with refs/', 422);
      if (!repo.objects.has(sha)) return err('sha does not exist', 422);
      if (repo.refs.has(ref)) return err('ref already exists', 422);
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: 'commit' } }, 201);
    }
    if (method === 'GET' && tail.length === 3 && tail[1] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[2] as string)}`);
      if (!sha) return notFound();
      return ok({ ref: `refs/heads/${tail[2]}`, object: { sha, type: 'commit' } });
    }
    return notFound();
  }

  // Commits.
  if (sub === 'commits') {
    if (!repo) return notFound();
    if (method !== 'GET') return notFound();
    const ref = query.sha ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) return notFound();
    const commits = store.listCommits(repo, tip).map((entry) => {
      const view = store.commitOf(repo, entry.sha);
      const ident = (text: string): { name: string; email: string; date: string } => {
        const match = /^(.*?) <(.*?)> (\d+) ([+-]\d+)$/.exec(text ?? '');
        return {
          name: match?.[1] ?? 'forge',
          email: match?.[2] ?? 'forge@example.invalid',
          date: match?.[3] ? new Date(Number(match[3]) * 1000).toISOString() : '2026-11-19T00:00:00Z',
        };
      };
      return {
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: ident(view?.author ?? ''),
          committer: ident(view?.committer ?? ''),
        },
      };
    });
    return ok(commits);
  }

  // Contents.
  if (sub === 'contents') {
    if (!repo) return notFound();
    const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
    if (method === 'GET') {
      const read = store.readContent(repo, path, query.ref);
      if (!read) return notFound();
      if (read.kind === 'file') {
        return ok({
          type: 'file',
          encoding: 'base64',
          content: read.content.toString('base64'),
          sha: read.sha,
          size: read.size,
          name: read.name,
          path: read.path,
        });
      }
      return ok(read.entries);
    }
    if (method === 'PUT') {
      if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
        return err('message and content are required', 422);
      }
      let content: Buffer;
      try {
        content = Buffer.from(body.content as string, 'base64');
      } catch {
        return err('content is not valid base64', 422);
      }
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const existed = branch
        ? store.branchTip(repo, branch) !== null && store.readContent(repo, path, branch)?.kind === 'file'
        : store.readContent(repo, path)?.kind === 'file';
      const result = store.putContent(repo, path, content, body.message as string, branch, sha);
      if ('error' in result) return err(result.error, result.status);
      return ok(
        {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.contentSha,
            size: content.length,
            encoding: 'base64',
            type: 'file',
          },
          commit: { sha: result.commitSha, message: body.message },
        },
        existed ? 200 : 201,
      );
    }
    if (method === 'DELETE') {
      if (!isRecord(body)) return err('body must be an object', 400);
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = store.deleteContent(repo, path, typeof body.message === 'string' ? body.message : 'delete', sha);
      if ('error' in result) return err(result.error, result.status);
      return ok({ commit: { sha: result.commitSha } });
    }
    return notFound();
  }

  // Labels.
  if (sub === 'labels') {
    if (!repo) return notFound();
    if (method !== 'POST') return notFound();
    if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
      return err('name is required', 422);
    }
    const name = body.name as string;
    if (repo.labels.has(name)) return err(`label ${name} already exists`, 422);
    const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
    repo.labels.set(name, label);
    return ok({ name: label.name, color: label.color, description: '' }, 201);
  }

  // Issues.
  if (sub === 'issues') {
    if (!repo) return notFound();
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const sort = query.sort ?? 'created';
        const direction = query.direction ?? 'desc';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const page = paginate(
          issues.map((issue) => store.issueJson(issue, repo)),
          query,
          `/api/v3/repos/${owner}/${repoName}/issues`,
          ctx.origin,
        );
        return ok(page.items, 200, linkHeaders(page.link));
      }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
          return err('title is required', 422);
        }
        const labelNames = Array.isArray(body.labels)
          ? (body.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const result = store.createIssue(
          repo,
          body.title as string,
          typeof body.body === 'string' ? body.body : '',
          labelNames,
        );
        if ('error' in result) return err(result.error, result.status);
        return ok(store.issueJson(result, repo), 201);
      }
      return notFound();
    }
    const number = parseInt(tail[0] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.get(number);
    if (tail.length === 1) {
      if (!issue) return notFound();
      if (method === 'GET') return ok(store.issueJson(issue, repo));
      if (method === 'PATCH') {
        if (!isRecord(body)) return err('body must be an object', 400);
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return ok(store.issueJson(issue, repo));
      }
      return notFound();
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (!issue) return notFound();
      if (method === 'GET') {
        return ok(issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.body !== 'string') return err('body is required', 422);
        const id = repo.nextCommentId;
        repo.nextCommentId += 1;
        issue.comments.push({ id, globalId: globalId('IssueComment', repo.id, issue.number, id), body: body.body as string });
        return ok({ id, body: body.body }, 201);
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (sub === 'pulls') {
    if (!repo) return notFound();
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = paginate(
          pulls.map((pull) => store.pullJson(pull, repo)),
          query,
          `/api/v3/repos/${owner}/${repoName}/pulls`,
          ctx.origin,
        );
        return ok(page.items, 200, linkHeaders(page.link));
      }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
          return err('title, head and base are required', 422);
        }
        const result = store.createPull(
          repo,
          body.title as string,
          typeof body.body === 'string' ? body.body : '',
          body.head as string,
          body.base as string,
        );
        if ('error' in result) return err(result.error, result.status);
        return ok(store.pullJson(result, repo), 201);
      }
      return notFound();
    }
    const number = parseInt(tail[0] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (tail.length === 1) {
      if (!pull) return notFound();
      if (method !== 'GET') return notFound();
      return ok(store.pullJson(pull, repo));
    }
    if (tail.length === 2 && tail[1] === 'files') {
      if (!pull) return notFound();
      if (method !== 'GET') return notFound();
      return ok(store.pullFiles(repo, pull));
    }
    if (tail.length === 2 && tail[1] === 'merge') {
      if (!pull) return notFound();
      if (method !== 'PUT') return notFound();
      const result = store.mergePull(repo, pull);
      if ('error' in result) return err(result.error, result.status);
      return ok({ merged: true, sha: result.sha, message: result.message });
    }
    return notFound();
  }

  return notFound();
}
