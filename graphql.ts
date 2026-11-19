// GitHub GraphQL v4, POST /api/graphql. A hand-rolled executor for exactly
// the documents gh and github-mcp-server send (the suite's fixed document
// set): viewer, repository (+ its issue/pull-request connections),
// __type introspection, node(id:), the five mutations, and operation
// batching (a JSON array body answers an array, in order). An unknown field
// is HTTP 200 with an errors array naming it; an unknown repository is
// data.repository = null with no errors; unauthenticated is 401 (app.ts).

import { decodeGlobalId, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

type JsonRecord = Record<string, unknown>;

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  'createdAt', 'updatedAt', 'isPrivate',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(store: Store, repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: gqlState(issue.state),
    body: issue.body,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull, query: string): JsonRecord {
  const node: JsonRecord = {
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlState(pull.state),
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: store.pullMergeable(repo, pull),
  };
  if (query.includes('files(')) {
    const files = store.pullFiles(repo, pull);
    const firstMatch = /files\(\s*first:\s*(\d+)/.exec(query);
    const first = firstMatch ? parseInt(firstMatch[1] as string, 10) : 10;
    node.files = { nodes: files.slice(0, first).map((file) => ({ path: file.filename })) };
  }
  return node;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

interface IssuesArgs {
  first?: number;
  after?: string | null;
  states?: string[];
  orderDesc?: boolean;
}

function parseIssuesArgs(query: string, variables: JsonRecord): IssuesArgs {
  const args: IssuesArgs = {};
  if (typeof variables.first === 'number') args.first = variables.first;
  if (variables.after !== undefined) args.after = (variables.after as string | null) ?? null;
  const statesMatch = /states:\s*\[([^\]]*)\]/.exec(query);
  if (statesMatch) {
    args.states = (statesMatch[1] as string).split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  const orderMatch = /orderBy:\s*\{[^}]*direction:\s*(\w+)/.exec(query);
  if (orderMatch) args.orderDesc = orderMatch[1] === 'DESC';
  return args;
}

function issuesConnection(store: Store, repo: Repo, query: string, variables: JsonRecord): JsonRecord {
  const args = parseIssuesArgs(query, variables);
  let issues = [...repo.issues.values()];
  if (args.states && args.states.length > 0) {
    const wanted = new Set(args.states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  // Creation order is the number order; CREATED_AT DESC is numbers descending.
  issues.sort((a, b) => (args.orderDesc ? b.number - a.number : a.number - b.number));
  const afterNumber = cursorNumber(args.after);
  if (afterNumber !== null) {
    issues = issues.filter((issue) => (args.orderDesc ? issue.number < afterNumber : issue.number > afterNumber));
  }
  const first = args.first ?? issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return {
    nodes: page.map((issue) => issueNode(store, repo, issue)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function findRepoById(store: Store, databaseId: number): Repo | null {
  for (const repo of store.reposByName.values()) {
    if (repo.id === databaseId) return repo;
  }
  return null;
}

function repositoryNode(store: Store, repo: Repo, query: string, variables: JsonRecord): JsonRecord {
  const node: JsonRecord = {
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: store.branchTip(repo, repo.defaultBranch)
      ? { name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  if (query.includes('issues(')) node.issues = issuesConnection(store, repo, query, variables);
  if (query.includes('issue(number:')) {
    const number = variables.number as number | undefined;
    const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
    node.issue = issue ? issueNode(store, repo, issue) : null;
  }
  if (query.includes('pullRequests(')) {
    const first = typeof variables.first === 'number' ? variables.first : 100;
    const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
    node.pullRequests = { nodes: pulls.map((pull) => pullNode(store, repo, pull, query)) };
  }
  if (query.includes('pullRequest(number:')) {
    const number = variables.number as number | undefined;
    const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
    node.pullRequest = pull ? pullNode(store, repo, pull, query) : null;
  }
  return node;
}

function introspection(query: string): JsonRecord {
  const out: JsonRecord = {};
  const pattern = /(\w+):\s*__type\(name:\s*"([^"]+)"\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const alias = match[1] as string;
    const name = match[2] as string;
    if (query.includes('enumValues')) {
      const values = name === 'SearchType' ? SEARCH_TYPE_VALUES : [];
      out[alias] = { enumValues: values.map((value) => ({ name: value })) };
    } else {
      let fields: string[] = [];
      if (name === 'Issue') fields = ISSUE_FIELDS;
      else if (name === 'PullRequest') fields = PULL_REQUEST_FIELDS;
      else if (name === 'Repository') fields = REPOSITORY_FIELDS;
      out[alias] = { fields: fields.map((field) => ({ name: field })) };
    }
  }
  return out;
}

interface Execution {
  data: JsonRecord;
  errors?: Array<{ message: string }>;
}

function executeOne(store: Store, query: string, variables: JsonRecord): Execution {
  // Introspection.
  if (query.includes('__type(')) {
    return { data: introspection(query) };
  }
  // node(id:).
  if (/\bnode\s*\(/.test(query)) {
    const id = variables.id as string | undefined;
    const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
    if (!decoded) return { data: { node: null } };
    if (decoded.kind === 'Repository') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      return { data: { node: repo ? { id: repo.globalId, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } : null } };
    }
    if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      const number = Number(decoded.parts[1]);
      if (!repo) return { data: { node: null } };
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number);
        return { data: { node: issue ? { id: issue.globalId, number: issue.number, title: issue.title } : null } };
      }
      const pull = repo.pulls.get(number);
      return { data: { node: pull ? { id: pull.globalId, number: pull.number, title: pull.title } : null } };
    }
    return { data: { node: null } };
  }
  // Mutations.
  if (/mutation\s+IssueCreate/.test(query)) {
    const input = (variables.input ?? {}) as JsonRecord;
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : null;
    if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Repository not found' }] };
    const result = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
    if ('error' in result) return { data: { createIssue: null }, errors: [{ message: result.error }] };
    return { data: { createIssue: { issue: { number: result.number, id: result.globalId } } } };
  }
  if (/mutation\s+IssueClose/.test(query)) {
    const input = (variables.input ?? {}) as JsonRecord;
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : null;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue) return { data: { closeIssue: null }, errors: [{ message: 'Issue not found' }] };
    issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: issue.number, id: issue.globalId, state: 'CLOSED' } } } };
  }
  if (/mutation\s+PullRequestCreate/.test(query)) {
    const input = (variables.input ?? {}) as JsonRecord;
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : null;
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found' }] };
    const result = store.createPull(
      repo,
      String(input.title ?? ''),
      String((input as JsonRecord).body ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if ('error' in result) return { data: { createPullRequest: null }, errors: [{ message: result.error }] };
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: result.number,
            id: result.globalId,
            state: 'OPEN',
            headRefName: result.head,
            baseRefName: result.base,
          },
        },
      },
    };
  }
  if (/mutation\s+MergePullRequest/.test(query)) {
    const input = (variables.input ?? {}) as JsonRecord;
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded?.kind === 'PullRequest' ? findRepoById(store, Number(decoded.parts[0])) : null;
    const pull = repo?.pulls.get(Number(decoded?.parts[1]));
    if (!repo || !pull) return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
    const result = store.mergePull(repo, pull);
    if ('error' in result) return { data: { mergePullRequest: null }, errors: [{ message: result.error }] };
    return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'CLOSED' } } } };
  }
  if (/mutation\s+AddComment/.test(query)) {
    const input = (variables.input ?? {}) as JsonRecord;
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : null;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue) return { data: { addComment: null }, errors: [{ message: 'Issue not found' }] };
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment = { id, globalId: globalId('IssueComment', repo.id, issue.number, id), body: String(input.body ?? '') };
    issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: comment.globalId, body: comment.body } } } } };
  }
  // Queries: viewer.
  if (/\bviewer\s*\{/.test(query)) {
    const selection = /viewer\s*\{([^}]*)\}/.exec(query)?.[1] ?? '';
    const fields = selection.split(/[\s,]+/).map((field) => field.trim()).filter(Boolean);
    const unknown = fields.find((field) => field !== 'login');
    if (unknown) {
      return {
        data: { viewer: { login: store.viewerLogin } },
        errors: [{ message: `Cannot query field "${unknown}" on type "User".` }],
      };
    }
    return { data: { viewer: { login: store.viewerLogin } } };
  }
  // Queries: repository.
  if (/\brepository\s*\(/.test(query)) {
    const owner = variables.owner as string | undefined;
    const name = variables.name as string | undefined;
    const repo = typeof owner === 'string' && typeof name === 'string' ? store.findRepo(owner, name) : null;
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repositoryNode(store, repo, query, variables) } };
  }
  return { data: {}, errors: [{ message: 'Cannot query field on type "Query".' }] };
}

/** Answer one GraphQL HTTP body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: {}, errors: [{ message: 'Invalid operation' }] };
      const record = entry as JsonRecord;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as JsonRecord;
      return executeOne(store, query, variables);
    });
    return { status: 200, json: results };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, json: { message: 'GraphQL body must be an object' } };
  }
  const record = body as JsonRecord;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as JsonRecord;
  return { status: 200, json: executeOne(store, query, variables) };
}
