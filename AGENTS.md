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
- **Most commands come from the server.** Built-in commands (`builtins.ts`) work with this machine or a synced
  folder: login, logout, sessions (rename, forget), use, open, help, version, clone, link, status, sync, watch,
  conflicts, check-ignore. Everything else is declared
  by the server (`GET /v1/commands`): a description of one API call, never code, run by `declared.ts` and cached per
  server in `$XDG_CACHE_HOME/fontego/commands/`. Every answer carries the version of the server's commands
  (`fontego-commands` header); a different one refreshes the cache. With `--json`, a declared command prints exactly
  what the API answered. `cli/test/cli.test.ts` fails if the server declares something this CLI can't run. An
  argument marked `secret` (a password) is asked for without echo when left out, or read from stdin when that isn't a
  terminal (`prompt.ts`), and never printed. One marked `stdin` (a file's content, for `fontego write`) is read whole
  from stdin when left out; nothing on stdin is an error, so a forgotten `< file` never writes an empty file.
- **One machine, several Fontegos.** `fontego login` signs in through the browser (OAuth with PKCE and a loopback
  redirect), or with a code typed on another device when there is no display (`--device`); `--token` stays for
  scripts and CI. `config.json` lists the instances under short aliases and holds no secrets; credentials go to the
  system keychain (`Bun.secrets`), or to `credentials.json` (0600) where there is none. Each command goes to
  `--instance`, `FONTEGO_INSTANCE`, the synced folder's instance, or the default (`connect.ts`). Sessions renew by
  themselves under a lock: two processes swapping the same refresh token would make the server close the session.
- **Ignore rules never delete** (`core/src/ignore.ts`, read from disk by `cli/src/sync/ignore.ts`; they live in core
  because the server applies them too when it imports a folder, a zip or a Git repository into a new workspace). As
  in Git, a rule only keeps new files from going up: a file already in the workspace keeps syncing both ways, and
  `fontego status` says so, with the `fontego rm` that takes it out (the copy stays where the rules ignore it). Three levels: built-in (`.git`, `.fontego`, system and editor
  junk; keep it short), per machine (`.fontego/ignore`, never synced), and shared (`.fontegoignore` files at the top
  or in any folder, which sync and travel with templates; a deeper one wins). Full `.gitignore` syntax through the
  `ignore` library (MIT), case ignored. `fontego status --ignored` lists what they keep here and `fontego
  check-ignore PATH` says which rule. This is each copy's convenience; the paths a workspace protects or rejects
  (`core/paths.ts`) are the server's policy, and separate.
- **The CLI says which agent runs it** (`fontego-agent` header: `FONTEGO_AGENT`, or `claude-code` when `CLAUDECODE=1`),
  so the server's log reads "Ana, from claude-code". A label, never a permission.
- **`core` is the contract.** The API types, the path rules (`normalizePath`) and the Git blob hash (`blobHash`) must
  give the same result on the server and in every client. A change here is a change to the API: update `fontego-app`
  in the same go.
- **No company or brand in the code.** Fontego is the project's name.
- **Licenses: this repo is Apache 2.0, `fontego-app` is AGPL v3.** Never copy code from `fontego-app` into this repo:
  it would bring the AGPL with it. Code can go the other way, from here into the app.
- **Copyright and contributions.** The copyright holder is Joel Kassim Moratalla, Fontego's creator: keep `NOTICE`
  and the copyright lines as they are. Don't merge a contribution from anyone else until they have accepted the
  contributor agreement (`CLA.md`).
- **English** for code, commands, messages and docs.

## Layout

| Path | What |
|---|---|
| `core/` | `@fontego/core`: request schemas in Zod (`schemas.ts`), answer types (`types.ts`), what a declared command looks like (`commands.ts`) and its output templates (`template.ts`), path rules and the path patterns workspaces protect or reject (`paths.ts`), the ignore rules (`ignore.ts`, which read their files through a function) and the Git blob hash (`hash.ts`). It also re-exports `z`, so everyone shares one copy of Zod. `fontego-app` uses it through its `core` link |
| `cli/src/main.ts` | Reads the command line and runs a built-in or a declared command |
| `cli/src/args.ts` | Command words, arguments and flags, and usage lines |
| `cli/src/builtins.ts` | The built-in commands |
| `cli/src/declared.ts` | Commands the server declares: cache, checks, building the request, printing the answer |
| `cli/src/help.ts` | `fontego help`, `fontego help COMMAND` and `fontego help --agent`, built from the commands themselves |
| `cli/src/client.ts` | HTTP client for `/v1`: a token per request, and one more try after renewing on a 401 |
| `cli/src/config.ts` | The instances of this machine (`$XDG_CONFIG_HOME/fontego/config.json`, no secrets), the credential store (keychain or `credentials.json`), the first version's login moving over, and the renewal lock |
| `cli/src/auth.ts` | Signing in (browser or device flow), a stored session that renews itself, signing out on the server |
| `cli/src/connect.ts` | Which instance a command goes to, and a client signed in there; `FONTEGO_URL` with `FONTEGO_TOKEN` override it all |
| `cli/src/sync/` | Sync: `engine.ts` (one round: pull, push, conflicts; a file the server refuses, such as a protected path, is set aside and the rest sent), `local.ts` (scan, atomic writes), `ignore.ts` (the ignore rules, read from the folder), `state.ts` (`.fontego/state.json`), `watch.ts` (continuous mode and its lock) |
| `cli/test/` | Tests against a real server; `server.ts` starts it from `fontego-app` |

## How to work

```bash
bun install
bun test                 # needs fontego-app next to this repo (../fontego-app), or FONTEGO_APP_DIR
bun run typecheck
bun cli/src/main.ts help
```

- The tests run the server in a temporary folder on a free port; they never touch real data. They set
  `FONTEGO_CREDENTIAL_STORE=file` and `FONTEGO_BROWSER=none`, so they never write to the keychain or open a browser;
  `login.test.ts` plays the browser itself.
- Bun 1.3.14, and git 2.38 or newer for the server.
