# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vickythtaa-ux/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vickythtaa-ux/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (protocol v2), REST API v3, GraphQL and MCP over one in-memory deterministic store. No git binary, no database, no dependencies, no outside services.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later strips the TypeScript types on its own; the flag is harmless there. There is nothing to install: the program imports `node:http` and its own modules only.

The platform runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment. The lifecycle: bind an ephemeral port (`listen(0)`, never 8080), `POST $MAKEFUN_ENV_URL/register {"port": N}`, then poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}` and exit 0.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Auth is `Authorization: Bearer <token>` where the token is the process's `MAKEFUN_SHOP_TOKEN`. No token is a 401; a repository under another owner is a 404, never a 403.

Git objects are SHA-1 with hand-rolled pkt-line, pack read (v2/v3, OFS/REF deltas) and pack write; pushes are fast-forward only, refused per ref with `ng <ref> non-fast-forward`. The store is in-memory and deterministic: no random ids or timestamps in stored objects.

Practice trials with the kit's local suite: 969–975/1000 across the three trials, feature and agent checks 120/120.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server and router.
- `git.ts`, `git-http.ts`: object store, pack codec, smart HTTP.
- `rest.ts`, `graphql.ts`, `mcp.ts`: the REST v3, GraphQL and MCP surfaces.
- `store.ts`: the in-memory deterministic store.
- `scenario.ts`: the seeded scenario data.
- `LICENSE` (MIT).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
