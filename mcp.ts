// MCP over Streamable HTTP, POST /mcp. Plain JSON-RPC 2.0 (no SSE needed —
// the client sends ordinary HTTP POSTs and reads ordinary JSON replies).
// Revision 2026-07-28: server/discover first; a -32601/404 falls back to the
// legacy initialize handshake. Answers come within 3 s (the store is
// in-memory, so they come within milliseconds).

import { type Store } from './store.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRecord = Record<string, unknown>;

interface RpcResult {
  status: number;
  json: JsonRecord;
}

function ok(id: unknown, result: JsonRecord): RpcResult {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function error(id: unknown, code: number, message: string, status = 200): RpcResult {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A tool result carrying both text JSON and structuredContent (the client reads either). */
function toolOk(id: unknown, value: unknown): RpcResult {
  return ok(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
}

function toolError(id: unknown, message: string): RpcResult {
  return ok(id, { content: [{ type: 'text', text: message }], isError: true });
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function callTool(store: Store, id: unknown, name: string, args: JsonRecord): RpcResult {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return error(id, -32602, `Unknown tool: ${name}`);
  // Required arguments (by the canonical property names the suite fills).
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(id, `Missing required argument: ${required}`);
    }
  }
  const owner = asText(args.owner);
  const repoName = asText(args.repo);
  if (name === 'create_repo') {
    const repo = store.createRepo(asText(args.name), {
      description: asText(args.description),
      private: args.private === true,
    });
    if (!repo) return toolError(id, 'Repository already exists');
    return toolOk(id, {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.defaultBranch,
    });
  }
  const repo = store.findRepo(owner, repoName);
  if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
  if (name === 'get_repo') {
    return toolOk(id, {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.defaultBranch,
      description: repo.description,
    });
  }
  if (name === 'create_issue') {
    const result = store.createIssue(repo, asText(args.title), asText(args.body));
    if ('error' in result) return toolError(id, result.error);
    return toolOk(id, { id: result.id, number: result.number, title: result.title, body: result.body, state: result.state });
  }
  if (name === 'list_issues') {
    const state = asText(args.state) || 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.createdSeq - a.createdSeq);
    const list = issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    }));
    return toolOk(id, list);
  }
  if (name === 'create_pull_request') {
    const result = store.createPull(repo, asText(args.title), '', asText(args.head), asText(args.base));
    if ('error' in result) return toolError(id, result.error);
    return toolOk(id, {
      id: result.id,
      number: result.number,
      title: result.title,
      state: result.state,
      head: { ref: result.head, sha: result.headSha },
      base: { ref: result.base, sha: result.baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(asText(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (!pull) return toolError(id, `Pull request ${number} not found`);
    const result = store.mergePull(repo, pull);
    if ('error' in result) return toolError(id, result.error);
    return toolOk(id, { merged: true, sha: result.sha, message: result.message, number: pull.number });
  }
  return error(id, -32602, `Unknown tool: ${name}`);
}

/** Answer one MCP HTTP request. `body` is the parsed JSON (or null when the body was not JSON). */
export function handleMcp(store: Store, body: unknown, headers: Record<string, string | undefined>): RpcResult {
  if (body === null || body === undefined) {
    // Non-JSON body: HTTP 400 with a -32700 parse error.
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = asRecord(body);
  if (!request || typeof request.method !== 'string') {
    return error(request?.id ?? null, -32600, 'Invalid Request');
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = asRecord(request.params) ?? {};
  const requestedVersion =
    typeof (params._meta as JsonRecord | undefined)?.['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? ((params._meta as JsonRecord)['io.modelcontextprotocol/protocolVersion'] as string)
      : undefined;
  const headerVersion = headers['mcp-protocol-version'];
  const version = requestedVersion ?? headerVersion ?? '2026-07-28';
  const meta = { 'io.modelcontextprotocol/protocolVersion': version };

  if (method === 'server/discover') {
    return ok(id, {
      _meta: { ...meta, 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      supportedVersions: MCP_PROTOCOL_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      protocolVersion: version,
    });
  }
  if (method === 'initialize') {
    return ok(id, {
      _meta: { ...meta, 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized') {
    // A notification: no id, no result body needed.
    return { status: 202, json: {} };
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments) ?? {};
    // Match by suffix, case-insensitively (a server prefix is allowed).
    const tool = TOOLS.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith(candidate.name.toLowerCase()),
    );
    if (!tool) return error(id, -32602, `Unknown tool: ${name}`);
    return callTool(store, id, tool.name, args);
  }
  return error(id, -32601, `Method not found: ${method}`);
}