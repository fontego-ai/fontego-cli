# fontego-cli

The `fontego` command and `@fontego/core`, the contract that the Fontego server and every client share.

Fontego is an open source, self-hostable platform to host shared folders (workspaces) with permissions, history and
sync, made so that each person works with their own agent. This repo is the client side: `fontego` lets people, agents
and scripts explore workspaces and keep a local folder in sync. The server and the web app live in `fontego-app`.

## Principles

- **Everything goes through the API** (`/v1`). Every command accepts `--json`, and errors say what to do (`hint`).
- **Anything the web app can do, the CLI can do too.** The only exception is proving who you are (a password, an
  invitation, authorizing a machine), which happens in the browser.
- **The CLI only talks HTTP to the server.** It imports `@fontego/core`, never server code. Its tests start a real
  `fontego-server` and use it from the outside.
- **`core` is the contract.** The API types, the path rules (`normalizePath`) and the Git blob hash (`blobHash`) must
  give the same result on the server and in every client. A change here is a change to the API: update `fontego-app`
  in the same go.
- **No company or brand in the code.** Fontego is the project's name.
- **English** for code, commands, messages and docs.

## Layout

| Path | What |
|---|---|
| `core/` | `@fontego/core`: API types (`types.ts`), path rules (`paths.ts`) and the Git blob hash (`hash.ts`). `fontego-app` uses it through its `core` link |
| `cli/src/main.ts` | Commands and their help (`fontego help`, and `fontego help --agent` for AI agents) |
| `cli/src/client.ts` | HTTP client for `/v1` |
| `cli/src/config.ts` | The login, in `$XDG_CONFIG_HOME/fontego/config.json`; `FONTEGO_URL` and `FONTEGO_TOKEN` override it |
| `cli/src/sync/` | Sync: `engine.ts` (one round: pull, push, conflicts), `local.ts` (scan, atomic writes, `.fontegoignore`), `state.ts` (`.fontego/state.json`), `watch.ts` (continuous mode and its lock) |
| `cli/test/` | Tests against a real server; `server.ts` starts it from `fontego-app` |

## How to work

```bash
bun install
bun test                 # needs fontego-app next to this repo (../fontego-app), or FONTEGO_APP_DIR
bun run typecheck
bun cli/src/main.ts help
```

- The tests run the server in a temporary folder on a free port; they never touch real data.
- Bun 1.3.14, and git 2.38 or newer for the server.
