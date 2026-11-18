# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/saikorosnsbu-beep/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/saikorosnsbu-beep/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge implemented in TypeScript on the Node.js standard library only — no external dependencies. It serves the GitHub REST API surface for repositories, issues, and pull requests (including comments, labels, milestones, reviews, and merges), the Git smart-HTTP protocol (clone and push over `info/refs`, `git-upload-pack`, and `git-receive-pack`, with packfile parsing and generation, ofs/ref deltas, shallow clone and deepen, protocol v0 and v2), a GraphQL API, and an MCP server exposing the same domain as tools. All state lives in an in-memory store with a logical clock, so behavior is deterministic for a given sequence of requests. The git object layer implements SHA-1 addressed commits, trees, blobs, and tags, fast-forward checks on push, and pack caching for repeated fetches.

## Run it

```sh
MAKEFUN_ENV_URL=<env url> node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2b3m0p7y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
