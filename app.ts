// HTTP front door: routes each request to the git, REST, GraphQL or MCP
// handler, reads bodies, and owns the cross-cutting rules — JSON replies,
// the X-GitHub-Request-Id header on every REST reply, Bearer-token auth on
// every API surface except /healthz, and a JSON 404 for unknown routes.
// Keep-alive friendly: no Connection headers are forced, bodies are read
// with a bounded buffer, and nothing per request does more work than it must
// (the read bench does 2,000 sequential GETs on one connection).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGitHttp } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

export interface AppOptions {
  store: Store;
  /** The Bearer token expected on API calls (MAKEFUN_SHOP_TOKEN). */
  token: string;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  };
  if (value === null) {
    // 204 No Content: no body at all.
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(value);
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendBinary(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function parseJsonBody(buffer: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buffer.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(search);
  for (const [key, value] of params) out[key] = value;
  return out;
}

export function createApp(options: AppOptions) {
  const { store, token } = options;
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter((part) => part !== '');
      const host = req.headers.host ?? 'localhost';
      const origin = `http://${host}`;
      const query = parseQuery(url.search);

      // GET /healthz — no auth.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs and /git-upload-pack, /git-receive-pack.
      if (
        segments.length >= 3 &&
        segments[1] !== undefined &&
        segments[1].endsWith('.git') &&
        (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
      ) {
        const owner = decodeURIComponent(segments[0] as string);
        const repoName = decodeURIComponent((segments[1] as string).slice(0, -'.git'.length));
        const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        const response = handleGitHttp(store, method, owner, repoName, segments.slice(2), query, body, req.headers);
        sendBinary(res, response.status, response.body, response.contentType);
        return;
      }

      // Everything below needs a Bearer token.
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (presented !== token || presented === '') {
        sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId() });
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        let body: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId() });
            return;
          }
          body = parsed.value;
        }
        const response = handleRest({ store, origin }, method, restSegments, query, body);
        const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...response.headers };
        sendJson(res, response.status, response.json, headers);
        return;
      }

      // GraphQL.
      if (segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId() });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId() });
          return;
        }
        const response = handleGraphQL(store, parsed.value);
        sendJson(res, response.status, response.json, { 'x-github-request-id': requestId() });
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId() });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        const body = parsed.ok ? parsed.value : null;
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        const response = handleMcp(store, body, headers);
        if (response.status === 202) {
          res.writeHead(202);
          res.end();
          return;
        }
        sendJson(res, response.status, response.json, { 'x-github-request-id': requestId() });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId() });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId() });
      } else {
        res.destroy();
      }
    }
  });
}
