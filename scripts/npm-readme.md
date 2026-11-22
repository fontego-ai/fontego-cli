# fontego

`fontego` gives people, agents and scripts access to the workspaces of a Fontego server: shared folders with history
and per-workspace roles. Explore them, or keep a local folder in sync while you and your agent edit it with your usual
tools.

## Install

```bash
npm i -g fontego
```

Or, on Linux and macOS without npm:

```bash
curl -fsSL https://fontego.ai/install.sh | sh
```

Either way you get the same single executable, which doesn't need Bun; with npm, a small Node launcher runs it.

## Start

```bash
fontego login https://fontego.example.org   # opens the browser to sign in (--device without one)
fontego setup                               # teaches the AI agents on this machine to use fontego
fontego workspaces
fontego clone handbook && fontego watch handbook
```

## With an agent

`fontego setup` puts a short skill where Claude Code, Codex, GitHub Copilot CLI, OpenCode, Cursor and Gemini CLI look
for their skills, and `fontego setup --remove` takes it away. The skill tells them to run `fontego help --agent`: the
whole guide, written for agents, with the commands of your Fontego, so it never falls behind. Without the skill, tell
your agent: "run `fontego help --agent` and follow it".

## More

- `fontego help` lists every command, also the ones your server declares.
- Source and issues: https://github.com/fontego-ai/fontego-cli

Apache License 2.0. Copyright 2026 Joel Kassim Moratalla and the Fontego contributors.
