# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Cryptosans/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Cryptosans/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP
(upload-pack protocol v2, receive-pack v0) for clone, fetch and push; REST v3
under `/api/v3` for repositories, issues, pull requests and contents; GraphQL
v4 at `/api/graphql`; and an MCP endpoint at `/mcp`. No git binary, no outside
service, no database — the whole store is in memory, and every timestamp comes
from a logical clock, so a replay of the same requests produces the same state.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, and exits when the environment says the trial is done.
Set `MAKEFUN_SHOP_TOKEN` to the bearer token the suite presents.

## Layout

- `main.ts` — the entrypoint lifecycle: bind, register, wait for done.
- `app.ts` — the HTTP server: routing, auth, REST v3 and git smart HTTP.
- `store.ts` — the in-memory state: repositories, refs, objects, issues, pull
  requests, labels, comments, and the logical clock.
- `gitcore.ts` — the git object model: SHA-1 objects, trees, commits, tags,
  packfiles, pkt-lines, fetch selection, diffs and three-way merges.
- `graphql.ts` — a small GraphQL executor for the documents gh and
  github-mcp-server send, including introspection, mutations and batching.
- `mcp.ts` — the MCP endpoint (revision 2026-07-28): `server/discover`,
  `tools/list` and `tools/call` for the six forge tools.

## How it works

Git objects are stored by SHA-1 and addressed exactly like git addresses
them: commits, trees, blobs and annotated tags, with packfiles written plain
(no deltas) and read back with OFS/REF delta support. A fetch walks the
commit graph from the wants, honours haves (nothing already held is re-sent),
and supports shallow clones (`deepen`, `shallow`/`unshallow` boundaries).
Pushes unpack first and then apply each ref update with a fast-forward check,
reporting `ok`/`ng` per ref. Pull requests squash-merge with a file-level
three-way merge; a conflict answers 405.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nstczpc4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
