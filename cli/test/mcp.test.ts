// fontego mcp: setting Fontego's MCP up in the agents of a machine (a home of its own, with every agent there), the
// header an agent asks for, and the stdio proxy, against a real server, in both eras of the protocol.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "../src/agents.ts";
import { isOurs, placeFor, shellWord, urlOf } from "../src/mcp/configs.ts";
import { headersFor, messagesOf, runProxy } from "../src/mcp/proxy.ts";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const GOOD = "correct horse battery staple";
let s: TestServer;
let home: string;
let bin: string;
let cookie = "";

/** The environment of a person's machine here: its own home, its config, its PATH (fontego and the agents in bin). */
function env(extra: Record<string, string> = {}): Record<string, string> {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|COPILOT|OPENCODE|CURSOR|GEMINI|FONTEGO|XDG)/.test(k)),
  ) as Record<string, string>;
  return {
    ...clean,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    FONTEGO_CREDENTIAL_STORE: "file",
    FONTEGO_BROWSER: "none",
    ...extra,
  };
}

async function fontego(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], { env: env(opts.env), cwd: opts.cwd ?? home, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

const json = async (args: string[], opts?: Parameters<typeof fontego>[1]) => {
  const r = await fontego([...args, "--json"], opts);
  if (r.code !== 0) throw new Error(`fontego ${args.join(" ")}: ${r.out}${r.err}`);
  return JSON.parse(r.out);
};

const credentialsFile = () => join(home, "config", "fontego", "credentials.json");
const credentials = () => JSON.parse(readFileSync(credentialsFile(), "utf8"));

/** Ana, signed in on this machine through the browser, as a person does it. */
async function signIn() {
  const proc = Bun.spawn([process.execPath, MAIN, "login", s.url, "--json"], { env: env(), cwd: home, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) buf += new TextDecoder().decode((await reader.read()).value);
  const q = Object.fromEntries(new URL(JSON.parse(buf.slice(0, buf.indexOf("\n"))).url).searchParams);
  const browser = { cookie, "content-type": "application/json", "x-requested-with": "fontego-web" };
  const approved = await fetch(`${s.url}/v1/oauth/authorize`, { method: "POST", headers: browser, body: JSON.stringify({ ...q, approve: true }) });
  await fetch(((await approved.json()) as any).redirect);
  for (;;) if ((await reader.read()).done) break;
  expect(await proc.exited).toBe(0);
}

/**
 * A stand-in for the claude command, on the PATH: `claude mcp add-json -s user NAME JSON` and `claude mcp remove -s user
 * NAME` on $CLAUDE_CONFIG_DIR/.claude.json (or ~/.claude.json), as Claude Code keeps them.
 */
function fakeClaude() {
  const script = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, ".claude.json");
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const [, , mcp, cmd, , scope, name, entry] = process.argv;
fs.appendFileSync(path.join(process.env.HOME, "claude-calls.log"), process.argv.slice(2).join(" ") + "\\n");
if (mcp !== "mcp" || scope !== "user") process.exit(2);
doc.mcpServers ??= {};
if (cmd === "add-json") { if (doc.mcpServers[name]) { console.error("MCP server " + name + " already exists"); process.exit(1); } doc.mcpServers[name] = JSON.parse(entry); }
else if (cmd === "remove") delete doc.mcpServers[name];
else process.exit(2);
fs.writeFileSync(file, JSON.stringify(doc, null, 2));
`;
  writeFileSync(join(bin, "claude"), script, { mode: 0o755 });
}

beforeAll(async () => {
  s = await startTestServer();
  home = tempDir("fontego-cli-mcp-");
  bin = join(home, "bin");
  mkdirSync(bin);
  // fontego on the PATH, as installed: what the agents' configs run.
  writeFileSync(join(bin, "fontego"), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(MAIN)} "$@"\n`, { mode: 0o755 });
  fakeClaude();
  for (const d of [".codex", ".copilot", "config/opencode", ".cursor", ".gemini"]) mkdirSync(join(home, d), { recursive: true });
  chmodSync(join(home, ".copilot"), 0o700);
  const link = (await s.call(s.adminToken, "POST", "/v1/admin/users/invitations", { email: "ana@example.org" })).data.delivery.link;
  const set = await fetch(`${s.url}/v1/links/${/#\/link\/(\S+)/.exec(link)![1]}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: GOOD }) });
  cookie = (set.headers.get("set-cookie") ?? "").split(";")[0]!;
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "notes" });
  await s.call(s.adminToken, "PUT", "/v1/workspaces/notes/members/ana@example.org", { role: "editor" });
  await s.call(s.adminToken, "PUT", "/v1/workspaces/notes/files/plan.md", { content: "# Plan\n" });
  await signIn();
});
afterAll(async () => {
  await s.stop();
  rmSync(home, { recursive: true, force: true });
});

const helperOf = (p: string) => (Bun.TOML.parse(readFileSync(p, "utf8")) as any).mcp_servers.fontego;

describe("fontego mcp add and remove, for a person", () => {
  test("every agent here, each its own way, with no secret written; again changes nothing", async () => {
    const r = await json(["mcp", "add"]);
    expect(r.url).toBe(`${s.url}/mcp`);
    expect(r.results.map((x: any) => [x.agents.join(","), x.way, x.status])).toEqual([
      ["Claude Code", "header", "written"],
      ["Codex", "header", "written"],
      ["GitHub Copilot CLI", "proxy", "written"],
      ["OpenCode", "proxy", "written"],
      ["Cursor", "proxy", "written"],
      ["Gemini CLI", "proxy", "written"],
    ]);
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.fontego;
    expect(claude).toEqual({ type: "http", url: `${s.url}/mcp`, headersHelper: `${join(bin, "fontego")} mcp header --url ${s.url} --agent claude-code` });
    const codex = helperOf(join(home, ".codex", "config.toml"));
    expect(codex.url).toBe(`${s.url}/mcp`);
    // Codex runs it with HOME and PATH alone: where the sign-in is goes in front.
    expect(codex.http_headers_helper).toBe(`env XDG_CONFIG_HOME=${join(home, "config")} FONTEGO_CREDENTIAL_STORE=file ${join(bin, "fontego")} mcp header --url ${s.url} --agent codex`);
    const proxy = (agent: string) => [join(bin, "fontego"), "mcp", "proxy", "--url", s.url, "--agent", agent];
    expect(JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")).mcpServers.fontego).toEqual({ type: "local", command: proxy("copilot")[0], args: proxy("copilot").slice(1), tools: ["*"] });
    expect(JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8")).mcp.fontego).toEqual({ type: "local", command: proxy("opencode"), enabled: true });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.fontego).toMatchObject({ type: "stdio", args: proxy("cursor").slice(1) });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.fontego).toEqual({ command: proxy("gemini")[0], args: proxy("gemini").slice(1) });
    for (const f of [".claude.json", ".codex/config.toml", ".copilot/mcp-config.json", "config/opencode/opencode.json"]) {
      expect(readFileSync(join(home, f), "utf8")).not.toContain("fontego_");
    }
    const again = await json(["mcp", "add"]);
    expect(again.results.map((x: any) => x.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
    const state = await json(["mcp"]);
    expect(state.rows.filter((x: any) => x.scope === "user").map((x: any) => x.state)).toEqual(["ours", "ours", "ours", "ours", "ours", "ours"]);
  });

  test("the text says where and how, and how to undo it", async () => {
    const r = await fontego(["mcp", "add", "codex"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Fontego's MCP at ${s.url}/mcp, as ana@example.org, with this machine's session:`);
    expect(r.out).toContain("~/.codex/config.toml");
    expect(r.out).toContain("unchanged (Codex, with your session, through fontego mcp header)");
    expect(r.out).toContain("Undo: fontego mcp remove");
  });

  test("what else the files hold stays, comments too; an entry of that name it didn't write is never touched", async () => {
    const toml = join(home, ".codex", "config.toml");
    writeFileSync(toml, `# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n\n${readFileSync(toml, "utf8")}`);
    const copilot = join(home, ".copilot", "mcp-config.json");
    const theirs = { type: "http", url: "https://elsewhere.example/mcp" };
    writeFileSync(copilot, JSON.stringify({ mcpServers: { fontego: theirs } }));
    const r = await json(["mcp", "add", "codex", "copilot"]);
    expect(r.results[0].status).toBe("unchanged");
    expect(r.results[1]).toMatchObject({ status: "kept", reason: expect.stringContaining("didn't write") });
    expect(r.results[1].snippet).toContain('"proxy"');
    expect(JSON.parse(readFileSync(copilot, "utf8")).mcpServers.fontego).toEqual(theirs);
    const removed = await json(["mcp", "remove", "codex", "copilot"]);
    expect(removed.results.map((x: any) => x.status)).toEqual(["removed", "kept"]);
    expect(readFileSync(toml, "utf8")).toBe(`# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n`);
    expect(JSON.parse(readFileSync(copilot, "utf8")).mcpServers.fontego).toEqual(theirs);
    writeFileSync(copilot, "{}");
  });

  test("a file with comments isn't rewritten: the entry to add by hand instead", async () => {
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(file, '{\n  // mine\n  "mcpServers": {}\n}\n');
    const r = await json(["mcp", "add", "cursor"]);
    expect(r.results[0]).toMatchObject({ status: "kept", reason: expect.stringContaining("comments") });
    expect(JSON.parse(r.results[0].snippet).mcpServers.fontego.args).toEqual(["mcp", "proxy", "--url", s.url, "--agent", "cursor"]);
    expect(readFileSync(file, "utf8")).toContain("// mine");
    writeFileSync(file, "{}");
  });

  test("another Fontego under the same name, an unknown agent, a bad name, a script's token: each says what to do", async () => {
    const other = JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8"));
    other.mcp.fontego.command[4] = "https://other.example";
    writeFileSync(join(home, "config", "opencode", "opencode.json"), JSON.stringify(other));
    const r = await json(["mcp", "add", "opencode"]);
    expect(r.results[0].reason).toContain("another Fontego (https://other.example)");
    expect((await json(["mcp", "add", "opencode", "--name", "fontego-two"])).results[0].status).toBe("written");
    // Nor is it taken out from here.
    expect((await json(["mcp", "remove", "opencode"])).results[0]).toMatchObject({ status: "kept", reason: expect.stringContaining("another Fontego") });
    other.mcp.fontego.command[4] = s.url;
    writeFileSync(join(home, "config", "opencode", "opencode.json"), JSON.stringify({ ...other, mcp: { ...JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8")).mcp, fontego: other.mcp.fontego } }));
    expect((await fontego(["mcp", "add", "vim"])).err).toContain('doesn\'t know an agent "vim"');
    expect((await fontego(["mcp", "add", "--name", "a b"])).err).toContain("--name takes letters");
    const token = s.token("ana@example.org");
    expect((await fontego(["mcp", "add"], { env: { FONTEGO_URL: s.url, FONTEGO_TOKEN: token, FONTEGO_ALLOW_HTTP: "1" } })).err).toContain("this machine's session");
  });

  test("--print shows each entry and writes nothing", async () => {
    const r = await json(["mcp", "add", "gemini", "claude-code", "--print"]);
    expect(r.action).toBe("print");
    const claude = r.results.find((x: any) => x.agents[0] === "Claude Code");
    expect(claude.snippet).toContain("fontego mcp header");
    expect(claude.snippet).toStartWith("claude mcp add-json -s user fontego ");
    expect(r.results.find((x: any) => x.agents[0] === "Gemini CLI").snippet).toContain('"proxy"');
    expect(r.results.every((x: any) => x.reason === "printed, not written")).toBe(true);
  });

  test("remove takes out what it wrote, and only that", async () => {
    const r = await json(["mcp", "remove"]);
    expect(r.results.filter((x: any) => x.status === "removed").map((x: any) => x.agents[0])).toEqual(["Claude Code", "OpenCode", "Gemini CLI"]);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8")).mcp).toHaveProperty("fontego-two");
    expect((await json(["mcp", "remove", "opencode", "--name", "fontego-two"])).results[0].status).toBe("removed");
    expect((await fontego(["mcp", "remove"])).out).toContain("wasn't set up for any agent here");
  });
});

describe("fontego mcp add and remove, what else a machine may have", () => {
  test("a config kept as a link (a dotfiles repository) is written where it leads, and stays a link", async () => {
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    writeFileSync(join(dotfiles, "cursor-mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
    const link = join(home, ".cursor", "mcp.json");
    rmSync(link, { force: true });
    symlinkSync(join(dotfiles, "cursor-mcp.json"), link);
    expect((await json(["mcp", "add", "cursor"])).results[0].status).toBe("written");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(dotfiles, "cursor-mcp.json"), "utf8")).mcpServers)).toEqual(["mine", "fontego"]);
    expect((await json(["mcp", "remove", "cursor"])).results[0].status).toBe("removed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    rmSync(link);
    writeFileSync(link, "{}");
  });

  test("the command written is absolute, and the fontego that knows mcp", async () => {
    // A relative entry on the PATH: the path written is absolute all the same.
    const r = await json(["mcp", "add", "gemini"], { env: { PATH: `bin:/usr/bin:/bin` } });
    expect(r.results[0].status).toBe("written");
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.fontego.command).toBe(join(bin, "fontego"));
    await json(["mcp", "remove", "gemini"]);
    // An older fontego first on the PATH, which doesn't know mcp: this one is written instead.
    const old = join(home, "old-bin");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "fontego"), "#!/bin/sh\necho 'Unknown command' >&2\nexit 1\n", { mode: 0o755 });
    await json(["mcp", "add", "gemini"], { env: { PATH: `${old}:${bin}:/usr/bin:/bin` } });
    const entry = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.fontego;
    expect([entry.command, ...entry.args.slice(0, 3)]).toEqual([process.execPath, "--no-env-file", "--config=/dev/null", MAIN]);
    await json(["mcp", "remove", "gemini"]);
    // From the source, that command takes nothing from the folder the agent runs it in, as the executable
    // (build.test.ts): nor when it runs itself again, with the session's bus
    const folder = join(home, "someone-elses");
    mkdirSync(join(folder, "run"), { recursive: true });
    writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./planted.ts"]\n');
    writeFileSync(join(folder, "planted.ts"), `await Bun.write(${JSON.stringify(join(folder, "ran"))}, "ran");\n`);
    writeFileSync(join(folder, ".env"), "FONTEGO_URL=http://127.0.0.1:9\nFONTEGO_TOKEN=planted\n");
    writeFileSync(join(folder, "run", "bus"), "");
    const asAgent = { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: join(folder, "run") };
    for (const more of [{ FONTEGO_CREDENTIAL_STORE: "file" }, {}]) {
      const proc = Bun.spawn([entry.command, ...entry.args], { cwd: folder, env: { ...asAgent, ...more }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      expect(existsSync(join(folder, "ran"))).toBe(false);
    }
  });

  test("an agent named as it shows", async () => {
    expect((await json(["mcp", "add", "Gemini CLI", "--print"])).results[0].agents).toEqual(["Gemini CLI"]);
  });

  test("two names in Codex's config: the end of one never reads as the end of the other", async () => {
    await json(["mcp", "add", "codex"]);
    await json(["mcp", "add", "codex", "--name", "fontego-2"]);
    const toml = join(home, ".codex", "config.toml");
    // Someone deleted the first one's closing comment by hand: it isn't fontego's to cut any more, and the other stays.
    writeFileSync(toml, readFileSync(toml, "utf8").replace("# <<< fontego mcp add: fontego (end)\n", ""));
    const r = await json(["mcp", "remove", "codex"]);
    expect(r.results[0].status).toBe("kept");
    expect(helperOf(toml).url).toBe(`${s.url}/mcp`);
    expect((Bun.TOML.parse(readFileSync(toml, "utf8")) as any).mcp_servers["fontego-2"].url).toBe(`${s.url}/mcp`);
    writeFileSync(toml, "");
  });
});

describe("fontego mcp add --project", () => {
  test("one entry per file, for whoever works there with their own sign-in; remove takes them out", async () => {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const r = await json(["mcp", "add", "--project"], { cwd: project });
    expect(r.results.map((x: any) => [x.path, x.agents.join(","), x.status])).toEqual([
      [".mcp.json", "Claude Code,GitHub Copilot CLI", "written"],
      [".codex/config.toml", "Codex", "written"],
      ["opencode.json", "OpenCode", "written"],
      [".cursor/mcp.json", "Cursor", "written"],
      [".gemini/settings.json", "Gemini CLI", "written"],
    ]);
    const portable = { command: "fontego", args: ["mcp", "proxy", "--url", s.url] };
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" }, fontego: { type: "stdio", ...portable } });
    expect(helperOf(join(project, ".codex", "config.toml"))).toEqual(portable);
    expect(JSON.parse(readFileSync(join(project, "opencode.json"), "utf8")).mcp.fontego.command).toEqual(["fontego", ...portable.args]);
    const gone = await json(["mcp", "remove", "--project"], { cwd: project });
    expect(gone.results.map((x: any) => x.status)).toEqual(["removed", "removed", "removed", "removed", "removed"]);
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  });
});

describe("fontego mcp add --project, in a folder whose files someone else put there", () => {
  const outside = () => join(home, "outside");
  const project = (name: string) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside(), { recursive: true });
    return dir;
  };
  const resultOf = (r: any, path: string) => r.results.find((x: any) => x.path === path);

  test("a link that leads out of the folder, or one to nothing, is left alone, and nothing is written there", async () => {
    const dir = project("linked");
    writeFileSync(join(outside(), "other.json"), '{"keep":1}');
    writeFileSync(join(outside(), "settings.json"), '{"mine":true}');
    symlinkSync(join(outside(), "other.json"), join(dir, ".mcp.json"));
    symlinkSync(outside(), join(dir, ".gemini"));
    symlinkSync(join(outside(), "new.json"), join(dir, "opencode.json"));
    const r = await json(["mcp", "add", "--project"], { cwd: dir });
    for (const path of [".mcp.json", ".gemini/settings.json"]) {
      expect(resultOf(r, path)).toMatchObject({ status: "kept", reason: expect.stringContaining("leads out of this folder") });
    }
    expect(resultOf(r, "opencode.json")).toMatchObject({ status: "kept", reason: expect.stringContaining("leads nowhere") });
    expect(resultOf(r, ".cursor/mcp.json").status).toBe("written");
    const before = () => [readFileSync(join(outside(), "other.json"), "utf8"), readFileSync(join(outside(), "settings.json"), "utf8"), existsSync(join(outside(), "new.json"))];
    expect(before()).toEqual(['{"keep":1}', '{"mine":true}', false]);
    const gone = await json(["mcp", "remove", "--project"], { cwd: dir });
    expect(resultOf(gone, ".mcp.json").status).toBe("kept");
    expect(resultOf(gone, ".cursor/mcp.json").status).toBe("removed");
    expect(before()).toEqual(['{"keep":1}', '{"mine":true}', false]);
    const state = (await json(["mcp"], { cwd: dir })).rows.find((x: any) => x.scope === "project" && x.path === ".mcp.json");
    expect(state.state).toBe("unreadable");
  });

  test("a link inside the folder is followed, and nothing is written through one planted under a temporary name", async () => {
    const dir = project("inside");
    writeFileSync(join(dir, "shared.json"), "{}");
    symlinkSync("shared.json", join(dir, ".mcp.json"));
    await json(["mcp", "add", "--project", "claude-code"], { cwd: dir });
    expect(lstatSync(join(dir, ".mcp.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "shared.json"), "utf8")).mcpServers.fontego.command).toBe("fontego");
    // In this process, whose number is known: the temporary name had it once, and a link there was written through
    const other = project("planted");
    writeFileSync(join(outside(), "profile"), "# mine\n");
    for (const name of [`.mcp.json.fontego-${process.pid}.tmp`, `.mcp.json.${process.pid}.tmp`, ".mcp.json.tmp"]) symlinkSync(join(outside(), "profile"), join(other, name));
    const place = placeFor(AGENTS.find((a) => a.id === "claude-code")!, "project", { url: s.url, name: "fontego", self: ["fontego"], cwd: other, env: env() });
    expect(place.add({ url: s.url, name: "fontego", self: ["fontego"], cwd: other, env: env() })).toEqual({ status: "written" });
    expect(readFileSync(join(outside(), "profile"), "utf8")).toBe("# mine\n");
    expect(lstatSync(join(other, ".mcp.json")).isFile()).toBe(true);
  });
});

describe("fontego mcp header", () => {
  test("the session's access token, renewed when it has less than five minutes, as JSON", async () => {
    const before = credentials()[s.url];
    const h = JSON.parse((await fontego(["mcp", "header", "--url", s.url, "--agent", "claude-code"])).out);
    expect(h).toEqual({ Authorization: `Bearer ${before.accessToken}`, "fontego-agent": "claude-code" });
    writeFileSync(credentialsFile(), JSON.stringify({ ...credentials(), [s.url]: { ...before, accessExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
    const renewed = JSON.parse((await fontego(["mcp", "header", "--url", s.url])).out);
    expect(renewed.Authorization).not.toBe(`Bearer ${before.accessToken}`);
    expect(renewed.Authorization).toBe(`Bearer ${credentials()[s.url].accessToken}`);
    const ok = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers: { ...renewed, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(ok.status).toBe(200);
  });

  test("run the way Codex runs it, with HOME and PATH alone, it still finds the sign-in", async () => {
    await json(["mcp", "add", "codex"]);
    const helper = helperOf(join(home, ".codex", "config.toml")).http_headers_helper as string;
    const r = Bun.spawnSync(["sh", "-c", helper], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ Authorization: expect.stringMatching(/^Bearer fontego_at_/), "fontego-agent": "codex" });
  });

  test("--url wins over what the agent's environment says of another Fontego", async () => {
    const r = await fontego(["mcp", "header", "--url", s.url], { env: { FONTEGO_INSTANCE: "work", FONTEGO_URL: "https://other.example", FONTEGO_TOKEN: "fontego_pat_x" } });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).Authorization).toBe(`Bearer ${credentials()[s.url].accessToken}`);
  });

  test("not signed in to that Fontego: an error that says how", async () => {
    const r = await fontego(["mcp", "header", "--url", "https://elsewhere.example"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("fontego login");
  });
});

describe("fontego mcp proxy", () => {
  /** A line sent as it is, not as JSON */
  class Raw {
    constructor(readonly text: string) {}
  }
  /** The proxy as an agent runs it: messages in, one per line; their answers out, one per line. */
  async function proxy(messages: unknown[], extra: Record<string, string> = {}) {
    const p = Bun.spawn([process.execPath, MAIN, "mcp", "proxy", "--url", s.url, "--agent", "copilot"], {
      env: env(extra),
      cwd: home,
      stdin: new TextEncoder().encode(messages.map((m) => (m instanceof Raw ? m.text : JSON.stringify(m))).join("\n") + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { answers: out.trim() ? out.trim().split("\n").map((l) => JSON.parse(l)) : [], err, code };
  }
  const byId = (answers: any[], id: number) => answers.find((a) => a.id === id);

  test("the 2025-11-25 handshake, the tools, a call: as the server answers them", async () => {
    const r = await proxy([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "copilot-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cat", arguments: { workspace: "notes", path: "plan.md" } } },
    ]);
    expect(r.code).toBe(0);
    expect(r.answers).toHaveLength(3);
    expect(byId(r.answers, 1).result.serverInfo.name).toBe("fontego");
    expect(byId(r.answers, 2).result.tools.map((t: any) => t.name)).toContain("write");
    expect(byId(r.answers, 3).result.content[0].text).toBe("# Plan\n");
  });

  test("2026-07-28: each request with its envelope, sent with the headers that era asks for", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "gemini-cli", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const r = await proxy([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ls", arguments: { workspace: "notes" }, _meta: meta } },
    ]);
    expect(byId(r.answers, 1).result.tools.length).toBeGreaterThan(10);
    expect(byId(r.answers, 2).result.structuredContent.entries[0].path).toBe("plan.md");
  });

  test("an access token that stopped working is renewed, and the request goes again", async () => {
    writeFileSync(credentialsFile(), JSON.stringify({ ...credentials(), [s.url]: { ...credentials()[s.url], accessToken: "fontego_at_revoked" } }));
    const r = await proxy([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }]);
    expect(byId(r.answers, 1).result.serverInfo.name).toBe("fontego");
    expect(credentials()[s.url].accessToken).not.toBe("fontego_at_revoked");
  });

  test("a line that isn't JSON, and a session that ended: answers that say so", async () => {
    const bad = await proxy([new Raw("not json")]);
    expect(bad.answers[0].error.code).toBe(-32700);
    const saved = credentials();
    writeFileSync(credentialsFile(), JSON.stringify({ ...saved, [s.url]: { ...saved[s.url], accessToken: "fontego_at_x", refreshToken: "fontego_rt_gone" } }));
    const ended = await proxy([{ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }]);
    expect(byId(ended.answers, 7).error.message).toContain("fontego login");
    await signIn();
  });
});

describe("the proxy, against what a server may answer", () => {
  async function through(messages: unknown[], answer: (body: any) => Response) {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => answer(await req.json()) });
    const out: unknown[] = [];
    try {
      await runProxy(
        { url: `http://127.0.0.1:${server.port}/mcp`, token: async () => "t", agent: null },
        { lines: (async function* () { for (const m of messages) yield JSON.stringify(m); })(), write: (m) => out.push(m), log: () => {} },
      );
    } finally {
      server.stop(true);
    }
    return out;
  }

  test("a request the answer leaves without a result is answered all the same", async () => {
    const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
    const out = await through([{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } }], () => sse('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n'));
    expect(out).toHaveLength(2);
    expect((out[1] as any)).toMatchObject({ id: 7, error: { message: expect.stringContaining("without a result") } });
    const empty = await through([{ jsonrpc: "2.0", id: 8, method: "tools/list" }], () => new Response(null, { status: 202 }));
    expect(empty).toEqual([expect.objectContaining({ id: 8, error: expect.any(Object) })]);
  });

  test("what it logs carries no control characters, whoever wrote them", async () => {
    const logged: string[] = [];
    await runProxy(
      { url: "http://127.0.0.1:9/mcp", token: async () => Promise.reject(new Error("\u001b]52;c;aGk=\u0007 no")), agent: null },
      { lines: (async function* () { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }); })(), write: () => {}, log: (t) => logged.push(t) },
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toMatch(/[\u0000-\u001f]/);
    expect(logged[0]).toContain("no");
  });

  test("a batch is answered as one", async () => {
    const out = await through([[{ jsonrpc: "2.0", id: 1, method: "a" }, { jsonrpc: "2.0", id: 2, method: "b" }]], (body) =>
      Response.json(body.map((m: any) => ({ jsonrpc: "2.0", id: m.id, result: {} }))),
    );
    expect(out).toEqual([[{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]]);
  });
});

describe("the pieces", () => {
  test("which entries are fontego's, and which Fontego each connects", () => {
    expect(isOurs({ type: "http", url: "u", headersHelper: "/x/fontego mcp header --url https://a.example" })).toBe(true);
    expect(isOurs({ command: "fontego", args: ["mcp", "proxy", "--url", "https://a.example"] })).toBe(true);
    expect(isOurs({ type: "local", command: ["/bin/fontego", "mcp", "proxy"] })).toBe(true);
    expect(isOurs({ command: "npx", args: ["something-else"] })).toBe(false);
    expect(isOurs("nope")).toBe(false);
    expect(urlOf({ headersHelper: "'/a b/fontego' mcp header --url 'https://a.example' --agent x" })).toBe("https://a.example");
    expect(urlOf({ command: ["fontego", "mcp", "proxy", "--url", "https://b.example"] })).toBe("https://b.example");
  });

  test("shell words, the headers of each era, and answers in JSON or SSE", () => {
    expect(shellWord("/usr/bin/fontego")).toBe("/usr/bin/fontego");
    expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(headersFor({ method: "initialize" }, null)).not.toHaveProperty("mcp-protocol-version");
    expect(headersFor({ method: "tools/list" }, "2025-11-25")["mcp-protocol-version"]).toBe("2025-11-25");
    const modern = headersFor({ method: "tools/call", params: { name: "cat", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, "2025-11-25");
    expect([modern["mcp-protocol-version"], modern["mcp-method"], modern["mcp-name"]]).toEqual(["2026-07-28", "tools/call", "cat"]);
    expect(messagesOf('event: message\ndata: {"id":1}\n\nevent: message\ndata: {"id":2}\n\n', "text/event-stream")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(messagesOf('[{"id":1},{"id":2}]', "application/json")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(messagesOf("", "application/json")).toEqual([]);
  });
});

test("signed out, fontego mcp remove still takes out what it wrote", async () => {
  await json(["mcp", "add", "copilot"]);
  const saved = readFileSync(credentialsFile(), "utf8");
  rmSync(credentialsFile());
  try {
    expect((await fontego(["whoami"])).code).not.toBe(0);
    expect((await json(["mcp"])).rows.find((r: any) => r.agents.includes("GitHub Copilot CLI") && r.scope === "user").state).toBe("ours");
    expect((await json(["mcp", "remove", "copilot"])).results[0].status).toBe("removed");
  } finally {
    writeFileSync(credentialsFile(), saved, { mode: 0o600 });
  }
});

test("help lists the mcp commands for this machine", async () => {
  const r = await fontego(["help"]);
  for (const c of ["mcp add", "mcp remove", "mcp header", "mcp proxy"]) expect(r.out).toContain(c);
  expect(existsSync(join(home, "claude-calls.log"))).toBe(true);
});
