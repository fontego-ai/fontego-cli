# fontego-cli

The `fontego` command and `@fontego/core`, the contract that the Fontego server and every client share.

Fontego is an open source, self-hostable platform to host shared folders (workspaces) with permissions, history and
sync, made so that each person works with their own agent. This repo is the client side: `fontego` lets people, agents
and scripts explore workspaces and keep a local folder in sync. The server and the web app live in `fontego-app`.

## Principles

- **Everything goes through the API** (`/v1`). Every command accepts `--json`, and errors say what to do (`hint`).
  With `--json` nothing is ever asked, help and errors are JSON too, and the exit codes mean the same everywhere
  (`cli/src/output.ts`, written also in the agents' guide, `AGENT_INTRO` in `help.ts`: change both together).
- **Anything the web app can do, the CLI can do too.** The only exception is proving who you are (a password, an
  invitation, authorizing a machine), which happens in the browser.
- **The CLI only talks HTTP to the server.** It imports `@fontego/core`, never server code. Its tests start a real
  `fontego-server` and use it from the outside.
- **Most commands come from the server.** Built-in commands (`builtins.ts`) work with this machine or a synced
  folder: login, logout, sessions (rename, forget), use, open, help, version, clone, link, status, sync, watch,
  conflicts, check-ignore, and events (the person's live stream, `commands/live.ts`). Everything else is declared
  by the server (`GET /v1/commands`): a description of one API call, never code, run by `declared.ts` and cached per
  server in `$XDG_CACHE_HOME/fontego/commands/`. Every answer carries the version of the server's commands
  (`fontego-commands` header); a different one refreshes the cache. With `--json`, a declared command prints exactly
  what the API answered. `cli/test/cli.test.ts` fails if the server declares something this CLI can't run. An
  argument marked `secret` (a password) is asked for without echo when left out, or read from stdin when that isn't a
  terminal (`prompt.ts`), and never printed. One marked `stdin` (a file's content, for `fontego write`) is read whole
  from stdin when left out; nothing on stdin is an error, so a forgotten `< file` never writes an empty file.
- **A person who leaves an argument out is asked for it; nobody else ever is.** At a terminal, a required argument
  left out is picked from its list (`choices` in a declaration, from `core`: fixed values or a GET to the same
  server; `pick` in a built-in) or typed, and then the whole command goes to stderr (`Same as: fontego ...`), so it
  can be typed next time or handed to an agent (`ask.ts`). The list and the typing are our own code, with no
  dependencies (`picker.ts`: plain functions for the keys and the drawing, so tests need no terminal, and one that
  wires them to the terminal). `canAsk` (`output.ts`) is the one rule: never with `--json`, without a terminal on
  stdin and stderr, in CI, with `FONTEGO_NO_INPUT=1`, or when an agent runs it, since some run commands in a
  pseudo-terminal and would wait forever. Then the command fails with its usage line and the values a list on this
  machine allows. There is no full-screen interface: that is the web app's job.
- **One machine, several Fontegos.** `fontego login` signs in through the browser (OAuth with PKCE and a loopback
  redirect), or with a code typed on another device when there is no display (`--device`); `--token` stays for
  scripts and CI (`--token -` reads it from stdin, out of `ps` and the shell's history; `FONTEGO_TOKEN` counts for
  login only when `FONTEGO_URL` is that same Fontego). `config.json` lists the instances under short aliases and holds
  no secrets; credentials go to the system keychain (`Bun.secrets`), or to `credentials.json` (0600, in a 0700
  folder, written under a random name) where there is none. Each command goes to `--instance`, `FONTEGO_INSTANCE`,
  the synced folder's instance, or the default (`connect.ts`). Sessions renew by themselves under a lock: two
  processes swapping the same refresh token would make the server close the session. The lock is never taken from a
  process that still runs, and login and logout swap the credential under it too. Signing in as another account than
  before says so (`accountChanged`), and signing out says what stays open on the server (`stillOpen`: a token, or a
  session the server didn't close).
- **Credentials go only where the person said.** An instance's address is https, or plain http only to this machine
  (loopback) unless accepted: `fontego login --allow-http`, remembered for that instance, or `FONTEGO_ALLOW_HTTP=1`
  for `FONTEGO_URL`; never with a user name, query or fragment (`instanceUrl`, `config.ts`). No redirect is followed
  (`refuseRedirect`): a 307 or 308 would send a refresh token or a password again elsewhere. The client refuses a
  request off the instance's origin or outside its `/v1/`, whatever path a declared command gives. Links open
  without a shell (`openerCommand`: rundll32 on Windows, since cmd.exe reads the `&` of a link), only http(s);
  `fontego open` opens only a link on the instance's own origin, through a private page (`openPrivately`), so its
  one-time code is on no command line, where any user of the machine could read it. On Linux a browser in a sandbox
  with a /tmp of its own can't read that page (snap, such as Ubuntu's Firefox, and flatpak): it gets the link itself,
  a narrower risk than a link that never opens. `secretLinkWay` decides, from where the default browser's desktop
  entry is (`/var/lib/snapd/desktop/applications`, a flatpak `exports/share/applications`) or what it runs; when that
  can't be told, the page.
- **Ignore rules never delete** (`core/src/ignore.ts`, read from disk by `cli/src/sync/ignore.ts`; they live in core
  because the server applies them too when it imports a folder, a zip or a Git repository into a new workspace). As
  in Git, a rule only keeps new files from going up: a file already in the workspace keeps syncing both ways, and
  `fontego status` says so, with the `fontego rm` that takes it out (the copy stays where the rules ignore it). Three levels: built-in (`.git`, `.fontego`, system and editor
  junk; keep it short), per machine (`.fontego/ignore`, never synced), and shared (`.fontegoignore` files at the top
  or in any folder, which sync and travel with templates; a deeper one wins). The machine's rules come last and win
  over every shared one, so a `!secret.env` any editor writes can't send up what this machine keeps to itself. Full
  `.gitignore` syntax through the
  `ignore` library (MIT), case ignored. A rules file counts only as a plain file, never through a symlink (as Git
  reads .gitignore since 2.32), and only its first MiB (`MAX_RULES_BYTES`); `fontego status` names one that doesn't.
  `fontego status --ignored` lists what they keep here and `fontego
  check-ignore PATH` says which rule. This is each copy's convenience; the paths a workspace protects or rejects
  (`core/paths.ts`) are the server's policy, and separate.
- **The CLI says which agent runs it** (`fontego-agent` header: `FONTEGO_AGENT`, or the variables each agent sets in
  the commands it runs, such as `CLAUDECODE=1`; `agents.ts`), so the server's log reads "Ana, from claude-code". A
  label, never a permission. When an agent runs it, the general help and usage errors point it to `fontego help
  --agent`.
- **Agents learn fontego from fontego itself.** `fontego help --agent` is the one guide: it knows this CLI's version
  and the commands of the Fontego in use, so nothing else copies it. `fontego setup` (`commands/setup.ts`) writes a
  short skill (`SKILL`, the open Agent Skills format) into the user-level skill folders of the agents installed here
  (`skillsFolders` in `agents.ts`: one folder per set of agents, so none sees it twice), and only says when to use
  fontego and to run that guide. It marks what it writes, never touches a `fontego` skill it didn't write, and runs
  only when the person asks: nothing is written at install time. The docs publish the guide and the skill
  (`fontego-app/docs`, page "For agents", and llms.txt).
- **One executable per system** (`scripts/build.ts`, `bun run build`): `bun build --compile` for Linux, macOS and
  Windows, x64 and arm64, so people need neither Bun nor Node. The same build makes the GitHub release files
  (`fontego-<os>-<arch>`, `SHA256SUMS`, `install.sh`) and the npm packages: `fontego`, a Node launcher with no
  dependencies and no install script (`scripts/npm-launcher.cjs`, which passes signals and the exit code), and one
  `@fontego/cli-<os>-<arch>` per system as its optional dependencies, which npm picks by `os` and `cpu`. `install.sh`
  (Linux and macOS, no sudo) checks the download against `SHA256SUMS`. The version is written once, in
  `cli/package.json` (`version.ts`).
- **`core` is the contract.** The API types, the path rules (`normalizePath`, with the names Windows and macOS take for
  `.git` and `.fontego`; `symlinkTarget`, where a link may point) and the Git blob hash (`blobHash`) must
  give the same result on the server and in every client. A change here is a change to the API: update `fontego-app`
  in the same go. The server's operations declare their answer with these types (`answers` in its `operation.ts`),
  so a field renamed here breaks the server's type check, as it does the client's.
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
| `core/` | `@fontego/core`: request schemas in Zod (`schemas.ts`), answer types (`types.ts`), the closed list of each person's preferences with their schemas and defaults (`preferences.ts`), the closed list of icons a workspace can have, named by what they show, with the themes each suits (`icons.ts`), how a workspace's tags are written (`tags.ts`: `normalizeTag`, with no dependencies so the web app uses it too; `TagList` in `schemas.ts` wraps it), what a declared command looks like (`commands.ts`: a table, lines, a record that may end in a list, a message or raw bytes; a table or lines may print a list under each row, such as a commit's files, with how many more the API cut (`details`), lines after them all that are left out when empty, such as the next page's cursor (`footer`), and columns left out when nobody filled them (`optional`); `outputTemplates` finds every template in one; an argument's `choices`, the list a person picks it from, checked by `checkChoices`) and its output templates (`template.ts`), path rules and the path patterns workspaces protect or reject (`paths.ts`), the ignore rules (`ignore.ts`, which read their files through a function) and the Git blob hash (`hash.ts`). It also re-exports `z`, so everyone shares one copy of Zod. `fontego-app` uses it through its `core` link |
| `cli/src/main.ts` | Reads the command line and runs a built-in or a declared command |
| `cli/src/output.ts` | What fontego promises the program that runs it: when it may ask (`canAsk`, and `whyNotAsked`), how an error comes out (`failureOf`, `printFailure`) and the exit codes (`EXIT`: 6 the server can't be reached, 7 a sync that did only part) |
| `cli/src/args.ts` | Command words, arguments and flags, and usage lines |
| `cli/src/ask.ts` | The arguments a command was given without: asked for when a person can be asked, else the usage error with the values known here; and the command written back |
| `cli/src/picker.ts` | Asking at a terminal: picking from a list (arrows, filter by text or number, Enter, Esc) and typing a line, also a secret without echo; a numbered list where the terminal can't redraw (`TERM=dumb`) |
| `cli/src/builtins.ts` | Collects the built-in commands for dispatch, help and the reference docs. Instance and sign-in commands live in `cli/src/commands/instances.ts` and synced-folder commands in `cli/src/commands/folders.ts` |
| `cli/src/declared.ts` | Commands the server declares: cache, checks, building the request, printing the answer |
| `cli/src/help.ts` | `fontego help`, `fontego help COMMAND` and `fontego help --agent`, built from the commands themselves |
| `cli/src/agents.ts` | The coding agents fontego knows: the variables that tell one runs it, how to see one is installed, and the folders each reads user-level skills from |
| `cli/src/commands/setup.ts` | `fontego setup`: the skill and writing or removing it |
| `cli/src/version.ts` | The CLI's version, read from `cli/package.json` |
| `scripts/build.ts`, `scripts/npm-launcher.cjs`, `scripts/npm-readme.md`, `install.sh` | The release: executables, npm packages and the install script (see above) |
| `Dockerfile`, `.github/workflows/image.yml` | The command's container image and the workflow that publishes it (see How to work) |
| `cli/src/client.ts` | HTTP client for `/v1`: a token per request, only to the instance's origin under its `/v1/` and following no redirect, and one more try after renewing on a 401. Event streams (`events` for watch, `personEvents` for `fontego events`): the server says how often it beats in `ready`, and a line silent for two and a half beats is taken as dead, so the caller connects again |
| `cli/src/commands/live.ts` | `fontego events`: the person's stream (commits, who is in each workspace, changes in their list), one line per event or one JSON object per line, connecting again by itself. `who` and `here` come from the server |
| `cli/src/config.ts` | The instances of this machine (`$XDG_CONFIG_HOME/fontego/config.json`, no secrets) and the addresses accepted (`instanceUrl`), the credential store (keychain or `credentials.json`), the first version's login moving over, and the renewal lock (its holder's pid and host in it) |
| `cli/src/auth.ts` | Signing in (browser or device flow), a stored session that renews itself (and takes the account's address as the server has it then: a server admin may have changed it), replacing or removing a credential under the lock and closing it on the server (saying what stays open), and opening links in the browser |
| `cli/src/connect.ts` | Which instance a command goes to, and a client signed in there; `FONTEGO_URL` with `FONTEGO_TOKEN` override it all |
| `cli/src/sync/` | Sync: `engine.ts` (one round: pull, push in batches of at most `MAX_OPS` operations and `BATCH_BYTES`, saving the state after each, conflicts; a file the server refuses, such as a protected path, is set aside, the rest sent, and the same content tried again later with a growing wait; a copy that can only read asks for its role again while changes wait; a path the server has that can't be written here never stops the round: one that can't be here as things are (a name this system doesn't take, such as `aux.md` on Windows, a folder or a file in the way, a link that could lead out) is reported and left out until it changes, one that failed this once (no space, no permission, a download that doesn't match its hash) waits for the next round), `local.ts` (scan, which tells a folder it can't read from a deleted one; `replaceIf`, the only way sync changes a local file: the file is moved aside in one step, checked, and the new one linked in, so an edit saved meanwhile is never lost), `ignore.ts` (the ignore rules, read from the folder), `state.ts` (`.fontego/state.json`, checked when opened: `StateError`), `watch.ts` (continuous mode, and the folder's lock, taken by watch, sync and the first round of clone and link before they read the state) |
| `cli/test/` | Tests against a real server; `server.ts` starts it from `fontego-app` |

## How to work

```bash
bun install
bun test                 # needs fontego-app next to this repo (../fontego-app), or FONTEGO_APP_DIR
bun run typecheck
bun cli/src/main.ts help
bun run build            # dist/release (executables, SHA256SUMS, install.sh) and dist/npm (the npm packages)
bun run build --only linux-x64 --out /tmp/fontego-dist
```

- **Releasing** isn't automated yet, and nothing is published until the repos are public. A release is: bump
  `cli/package.json`, `bun run build`, upload `dist/release/*` to a GitHub release `vX.Y.Z`, then `npm publish` each
  folder of `dist/npm` (the `@fontego/cli-*` ones first, `fontego` last, with `--access public`). macOS executables
  built on Linux aren't signed: build those on a Mac (codesign) before a real release.
- **The container image** (`Dockerfile`): the same executable as a release (`scripts/build.ts`), on Debian slim with
  a shell for CI systems, as the user `fontego` (1000) in `/work`, with `FONTEGO_CREDENTIAL_STORE=file`. Bun
  cross-compiles and the last stage only copies files, so building it for another architecture needs no emulation.
  A tag `vX.Y.Z` on `fontego-ai/fontego-cli`, the version in `cli/package.json`, runs `.github/workflows/image.yml`:
  it tries the image (`version`, `help`, also as another user) and publishes the same digest as
  `ghcr.io/fontego-ai/fontego` (the one the docs give) and `docker.io/fontego/fontego`, tagged `X.Y.Z`, and for a
  version without a pre-release part `X.Y` and `latest`, for linux/amd64 and linux/arm64, with provenance and an
  SBOM. The repository needs the variable `DOCKERHUB_USERNAME` and the secret `DOCKERHUB_TOKEN`; forks skip it.
  `fontego-app`'s `scripts/check-image.sh` uses it against a server image, end to end.

- `cli/test/build.test.ts` builds this system's executable and uses it as a person would: on its own, through the
  npm launcher, and installed by `install.sh` from a local server laid out like GitHub releases.
- `cli/test/safety.test.ts` checks, inside the test process, what keeps credentials where they belong: addresses,
  where requests go, redirects, what opens in the browser, the renewal lock and the private files.
- The tests run the server in a temporary folder on a free port; they never touch real data. They run as no agent
  (`NO_AGENT` in `cli.test.ts`), whatever runs them, unless a test names one: its name would land in every commit. They set
  `FONTEGO_CREDENTIAL_STORE=file` and `FONTEGO_BROWSER=none`, so they never write to the keychain or open a browser;
  `login.test.ts` plays the browser itself.
- Bun 1.3.14, and git 2.38 or newer for the server.
