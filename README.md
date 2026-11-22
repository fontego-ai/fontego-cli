# fontego-cli

`fontego` gives people, agents and scripts access to the workspaces of a Fontego server: folders of files with history
and per-workspace permissions. Explore them, or keep a local folder in sync while you edit it with your usual tools.

```bash
npm i -g fontego                               # or: curl -fsSL https://fontego.ai/install.sh | sh
fontego login https://fontego.example.org      # opens the browser to sign in (--device without one)
fontego setup                                  # teaches the AI agents on this machine to use fontego
fontego workspaces
fontego clone handbook && fontego watch handbook
fontego help --agent      # how to use it, written for an AI agent
```

`fontego` is a single executable for Linux, macOS and Windows; it needs neither Bun nor Node. `fontego setup` puts a
short skill where Claude Code, Codex, GitHub Copilot CLI, OpenCode, Cursor and Gemini CLI look for skills; it tells
them to run `fontego help --agent`, which always matches your CLI and your server.

In a container, for CI jobs and machines without Node (Linux, x64 and arm64):

```bash
docker run --rm -e FONTEGO_URL=https://fontego.example.org -e FONTEGO_TOKEN -v "$PWD:/work" \
  ghcr.io/fontego-ai/fontego clone handbook
```

Besides the commands for a synced folder, `fontego` runs the ones your server declares, so a newer server brings its
new commands to every CLI without an update. `fontego help` lists what yours offers.

This repo also holds `@fontego/core`, the API contract shared with the server. The server and the web app are in
`fontego-app`. To work on it, see `AGENTS.md`.

## License

Apache License 2.0 (`LICENSE`): use it, change it and build on it, also in closed products. The server and the web app,
in `fontego-app`, are under the GNU Affero General Public License v3.

Copyright 2026 Joel Kassim Moratalla and the Fontego contributors (`NOTICE`). To contribute, see
`CONTRIBUTING.md`.
