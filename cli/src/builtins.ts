// Commands written in the CLI itself: the ones that work with this machine (signing in to instances) or with a synced
// folder. Everything else comes from the server (declared.ts).

import type { Credential as SavedCredential } from "./config.ts";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { Parsed, Usage } from "./args.ts";
import { UsageError } from "./args.ts";
import { browserLogin, deviceLogin, fetchInstance, fromTokenResponse, hasBrowser, openInBrowser, revokeSession } from "./auth.ts";
import { Client, ClientError } from "./client.ts";
import {
  aliasFor,
  configPath,
  credentialStore,
  defaultAlias,
  forgetInstance,
  instanceByAlias,
  instanceByUrl,
  listInstances,
  normalizeUrl,
  rememberStore,
  renameInstance,
  saveInstance,
  setDefault,
  type CredentialStore,
  type Instance,
} from "./config.ts";
import { connect, ensureMigrated, type Connection } from "./connect.ts";
import { forgetCommands, readCommands, refreshCommands, type CachedCommands } from "./declared.ts";
import { agentHelp, commandHelp, generalHelp } from "./help.ts";
import { localStatus, SyncEngine, type SyncReport } from "./sync/engine.ts";
import { loadIgnoreRules, type IgnoreMatch } from "./sync/ignore.ts";
import { isConflictCopy, scan } from "./sync/local.ts";
import { findRoot, loadState, newState, saveState } from "./sync/state.ts";
import { acquireLock, Watcher } from "./sync/watch.ts";

export const VERSION = "0.1.0";

export interface RunContext {
  parsed: Parsed;
  json: boolean;
  /** --instance, if given */
  instance?: string;
  print: (data: unknown, text: () => string) => void;
  /** Signs in to the instance this command is for (connect.ts). A synced folder's commands pass its URL. */
  connect: (opts?: { folderUrl?: string }) => Promise<Connection>;
}

export interface Builtin extends Usage {
  run(rc: RunContext): Promise<void>;
}

const DAY = 86_400_000;
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The saved commands of the instance help is about, refreshed if possible (quickly: help must not hang). */
async function commandsForHelp(rc: RunContext): Promise<{ cache: CachedCommands | null; stale: boolean; alias: string | null }> {
  let conn: Connection;
  try {
    conn = await rc.connect();
  } catch {
    return { cache: null, stale: false, alias: null };
  }
  try {
    return { cache: await refreshCommands(conn.client, 3000), stale: false, alias: conn.instance?.alias ?? null };
  } catch {
    return { cache: readCommands(conn.url), stale: true, alias: conn.instance?.alias ?? null };
  }
}

type Status = "active" | "ends soon" | "ended" | "signed out" | "token";

/** How an instance stands on this machine, from what is stored (no network). */
async function statusOf(i: Instance, store: CredentialStore): Promise<{ status: Status; endsAt: string | null }> {
  const c: SavedCredential | null = await store.get(i.url);
  if (!c) return { status: "signed out", endsAt: null };
  if (c.type === "token") return { status: "token", endsAt: null };
  const left = Date.parse(c.expiresAt) - Date.now();
  return { status: left <= 0 ? "ended" : left < 3 * DAY ? "ends soon" : "active", endsAt: c.expiresAt };
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const listed = () =>
  listInstances()
    .map((i) => `${i.alias} (${i.url})`)
    .join(", ");

/** Which instance `fontego login` is for: the one named, a URL, or one picked from the list. */
async function loginTarget(rc: RunContext): Promise<string> {
  const given = rc.parsed.args.TARGET;
  if (given) return given;
  const all = listInstances();
  if (!all.length) throw new UsageError("fontego login URL   (the address you open in the browser)");
  if (rc.json || !process.stdin.isTTY) throw new UsageError(`fontego login ALIAS or URL. Yours: ${listed()}`);
  const store = await credentialStore();
  console.log("Sign in to which Fontego?");
  for (const [n, i] of all.entries()) {
    const st = await statusOf(i, store);
    console.log(`  ${n + 1}) ${i.alias.padEnd(16)} ${i.name} · ${st.status}${st.endsAt ? ` until ${when(st.endsAt)}` : ""}`);
  }
  console.log(`  ${all.length + 1}) Another Fontego (URL)…`);
  const answer = (prompt("Number, alias or URL:") ?? "").trim();
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= all.length) return all[n - 1]!.alias;
  if (n === all.length + 1) {
    const url = (prompt("URL:") ?? "").trim();
    if (!url) throw new UsageError("fontego login URL");
    return url;
  }
  if (!answer) throw new UsageError("fontego login ALIAS or URL");
  return answer;
}

export function describeReport(r: SyncReport): string[] {
  const lines: string[] = [];
  for (const p of r.pulled) lines.push(`↓ ${p.status === "delete" ? "deleted " : ""}${p.path}`);
  for (const p of r.pushed) lines.push(`↑ ${p.status === "delete" ? "deleted " : ""}${p.path}${p.merged ? " (merged with other changes)" : ""}`);
  for (const c of r.conflicts) lines.push(`! ${c.message}`);
  for (const s of r.skipped) lines.push(`skipped ${s.path}: ${s.reason}`);
  for (const p of r.invalid) lines.push(`skipped ${p}: this name can't be synced`);
  if (r.readOnly && r.pending) lines.push(`${r.pending} local change(s) not sent: you can only read this workspace.`);
  return lines;
}

/** The synced folder a command works on, and a client for the instance it belongs to. */
async function folder(rc: RunContext, dirArg: string | undefined) {
  const root = findRoot(dirArg ?? process.cwd());
  if (!root) throw new UsageError(`${dirArg ?? "This folder"} is not a synced workspace. Create one with: fontego clone WORKSPACE [DIR]`);
  const state = await loadState(root);
  const online = async () => {
    const conn = await rc.connect({ folderUrl: state.url });
    return { engine: new SyncEngine(root, conn.client, state), client: conn.client, conn };
  };
  return { root, state, online };
}

const DIR = { name: "DIR", optional: true } as const;

/** "build/out.txt matches .fontegoignore:3 (build/)", for the rule that ignores a path. */
const ruleText = (m: IgnoreMatch) => `${m.source}${m.line ? `:${m.line}` : ""} (${m.pattern})${m.folder ? `, through the folder ${m.folder}/` : ""}`;
const MACHINE = "This machine";
const FOLDERS = "Synced folders";

export const BUILTINS: Builtin[] = [
  {
    name: "login",
    summary: "Sign in to a Fontego: opens the browser (or shows a code to type on another device)",
    group: MACHINE,
    args: [{ name: "TARGET", optional: true, description: "An alias you already have, or the address of a Fontego" }],
    flags: [
      { name: "device", type: "boolean", description: "Show a code to type in a browser on another device (no browser here)" },
      { name: "token", type: "string", value: "TOKEN", description: "Sign in with a token instead, for scripts and CI (or set FONTEGO_TOKEN)" },
      { name: "alias", type: "string", value: "ALIAS", description: "The short name to use for this Fontego (default: from its name)" },
    ],
    async run(rc) {
      await ensureMigrated();
      const target = await loginTarget(rc);
      const known = instanceByAlias(target) ?? (isUrl(target) ? instanceByUrl(target) : null);
      if (!known && !isUrl(target)) throw new UsageError(`No instance "${target}" on this machine.${listInstances().length ? ` Yours: ${listed()}.` : ""} Give its address: fontego login URL`);
      const url = known?.url ?? normalizeUrl(target);
      const info = await fetchInstance(url);
      const wanted = rc.parsed.flags.alias as string | undefined;
      if (wanted && !known && instanceByAlias(wanted)) throw new UsageError(`"${wanted}" is already the alias of ${instanceByAlias(wanted)!.url}.`);
      const alias = known?.alias ?? wanted ?? aliasFor(info.name, url);
      const store = await credentialStore();
      const say = (data: Record<string, unknown>, text: string) => (rc.json ? console.log(JSON.stringify(data)) : console.error(text));

      let cred: SavedCredential;
      let email: string;
      const token = (rc.parsed.flags.token as string | undefined) ?? process.env.FONTEGO_TOKEN;
      if (token) {
        email = (await new Client(url, token).me()).user.email;
        cred = { type: "token", token };
      } else {
        const t =
          rc.parsed.flags.device === true || !hasBrowser()
            ? await deviceLogin(url, {
                waiting: (d) =>
                  say(
                    { status: "waiting", verification_uri: d.verification_uri, user_code: d.user_code, verification_uri_complete: d.verification_uri_complete },
                    `To sign in to ${info.name}, open ${d.verification_uri} on any device and type the code ${d.user_code}\n(or open ${d.verification_uri_complete})\nWaiting…`,
                  ),
              })
            : await browserLogin(url, {
                waiting: (link) => {
                  const opened = openInBrowser(link);
                  say(
                    { status: "waiting", url: link, hint: `Open this link in a browser where you can sign in to ${info.name}.` },
                    `${opened ? "Opening the browser" : "Open this link in your browser"} to sign in to ${info.name}${opened ? "; if it doesn't open, go to" : ""}:\n  ${link}\nWaiting…`,
                  );
                },
              });
        cred = fromTokenResponse(t);
        email = t.session.email;
      }

      // A new sign-in replaces this machine's previous session there: close it on the server.
      const previous = await store.get(url);
      if (previous?.type === "session") await revokeSession(url, previous.refreshToken);
      await store.set(url, cred);
      rememberStore(store.kind);
      saveInstance({ alias, url, name: info.name, email, addedAt: known?.addedAt ?? new Date().toISOString() });
      const access = cred.type === "token" ? cred.token : cred.accessToken;
      await refreshCommands(new Client(url, access)).catch(() => {});
      const result = {
        ok: true,
        alias,
        url,
        name: info.name,
        user: { email },
        credential: cred.type,
        ...(cred.type === "session" ? { expiresAt: cred.expiresAt } : {}),
        default: defaultAlias() === alias,
        config: configPath(),
        store: store.kind,
      };
      if (rc.json) return console.log(JSON.stringify(result));
      console.log(
        cred.type === "session"
          ? `Signed in to ${info.name} (${alias}) as ${email}. The session ends on ${when(cred.expiresAt)} unless you use it before.`
          : `Signed in to ${info.name} (${alias}) as ${email}, with a token.`,
      );
    },
  },
  {
    name: "logout",
    summary: "Sign out of a Fontego (its session closes on the server too); --all: of every one",
    group: MACHINE,
    args: [{ name: "ALIAS", optional: true }],
    flags: [{ name: "all", type: "boolean", description: "Every Fontego of this machine" }],
    async run({ parsed, instance, print }) {
      await ensureMigrated();
      const alias = parsed.args.ALIAS || instance || process.env.FONTEGO_INSTANCE || defaultAlias();
      const targets = parsed.flags.all === true ? listInstances() : alias ? [instanceByAlias(alias)].filter((i): i is Instance => !!i) : [];
      if (!targets.length) throw new UsageError(alias ? `No instance "${alias}".` : "fontego logout ALIAS (or --all)");
      const store = await credentialStore();
      for (const i of targets) {
        const c = await store.get(i.url);
        if (c?.type === "session") await revokeSession(i.url, c.refreshToken);
        await store.delete(i.url);
        forgetCommands(i.url);
      }
      const names = targets.map((i) => i.alias);
      print({ ok: true, signedOut: names }, () => `Signed out of ${names.join(", ")}.`);
    },
  },
  {
    name: "sessions",
    summary: "The Fontegos of this machine: account, whether signed in, and when each session ends",
    group: MACHINE,
    async run({ print }) {
      await ensureMigrated();
      const store = await credentialStore();
      const d = defaultAlias();
      const rows: Array<Instance & { default: boolean; status: Status; endsAt: string | null }> = [];
      for (const i of listInstances()) rows.push({ ...i, default: i.alias === d, ...(await statusOf(i, store)) });
      print({ default: d, store: store.kind, instances: rows }, () => {
        if (!rows.length) return "No Fontego on this machine yet. Sign in to one with: fontego login URL";
        const cols = [["", "ALIAS", "NAME", "ACCOUNT", "STATUS", "ENDS", "URL"], ...rows.map((r) => [r.default ? "*" : "", r.alias, r.name, r.email ?? "", r.status, r.endsAt ? when(r.endsAt) : "", r.url])];
        const w = cols[0]!.map((_, c) => Math.max(...cols.map((row) => row[c]!.length)));
        return cols.map((row) => row.map((v, c) => (c === row.length - 1 ? v : v.padEnd(w[c]!))).join("  ").trimEnd()).join("\n") + "\n* default";
      });
    },
  },
  {
    name: "sessions rename",
    summary: "Give a Fontego another alias",
    group: MACHINE,
    args: [{ name: "ALIAS" }, { name: "NEW" }],
    async run({ parsed, print }) {
      await ensureMigrated();
      try {
        renameInstance(parsed.args.ALIAS!, parsed.args.NEW!);
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      print({ ok: true, alias: parsed.args.NEW }, () => `${parsed.args.ALIAS} is now ${parsed.args.NEW}.`);
    },
  },
  {
    name: "sessions forget",
    summary: "Sign out of a Fontego and take it off this machine's list",
    group: MACHINE,
    args: [{ name: "ALIAS" }],
    async run({ parsed, print }) {
      await ensureMigrated();
      const i = instanceByAlias(parsed.args.ALIAS!);
      if (!i) throw new UsageError(`No instance "${parsed.args.ALIAS}".`);
      const store = await credentialStore();
      const c = await store.get(i.url);
      if (c?.type === "session") await revokeSession(i.url, c.refreshToken);
      await store.delete(i.url);
      forgetCommands(i.url);
      forgetInstance(i.alias);
      print({ ok: true, forgot: i.alias }, () => `Forgot ${i.alias} (${i.url}).`);
    },
  },
  {
    name: "use",
    summary: "Choose the Fontego commands go to by default",
    group: MACHINE,
    args: [{ name: "ALIAS" }],
    async run({ parsed, print }) {
      await ensureMigrated();
      const alias = parsed.args.ALIAS!;
      if (!instanceByAlias(alias)) throw new UsageError(`No instance "${alias}".${listInstances().length ? ` Yours: ${listed()}.` : ""}`);
      setDefault(alias);
      print({ ok: true, default: alias }, () => `Commands go to ${alias} unless you say otherwise (--instance, or inside a synced folder).`);
    },
  },
  {
    name: "open",
    summary: "Open the web app, already signed in",
    group: MACHINE,
    args: [{ name: "WORKSPACE", optional: true }],
    flags: [{ name: "print", type: "boolean", description: "Only show the link (it works once, for two minutes)" }],
    async run({ parsed, json, print, connect: signIn }) {
      const { client } = await signIn();
      const ws = parsed.args.WORKSPACE;
      if (ws) await client.workspace(ws); // fails early if it doesn't exist for you
      const link = await client.sessionCode();
      const url = ws ? `${link.url}&next=${encodeURIComponent(`/w/${ws}`)}` : link.url;
      if (parsed.flags.print === true || json) return print({ url, expiresAt: link.expiresAt }, () => url);
      if (openInBrowser(url)) console.log("Opening the web app in your browser (the link works once, for two minutes).");
      else console.log(`Open this link in your browser (works once, for two minutes):\n${url}`);
    },
  },
  {
    name: "help",
    summary: "This help; with a command, its details; --agent: how to use fontego, for an AI agent",
    group: MACHINE,
    args: [{ name: "COMMAND", optional: true, rest: true }],
    flags: [{ name: "agent", type: "boolean", description: "Markdown for an AI agent" }],
    async run(rc) {
      const { parsed } = rc;
      const { cache, stale, alias } = await commandsForHelp(rc);
      const others = listInstances()
        .map((i) => i.alias)
        .filter((a) => a !== alias);
      if (parsed.flags.agent === true) return console.log(agentHelp(BUILTINS, cache, stale, { alias, others }));
      if (parsed.args.COMMAND) return console.log(commandHelp(parsed.args.COMMAND.split(" "), BUILTINS, cache));
      console.log(generalHelp(BUILTINS, cache, stale, VERSION, { alias, others }));
    },
  },
  {
    name: "version",
    summary: "The version of this CLI",
    group: MACHINE,
    async run() {
      console.log(VERSION);
    },
  },

  {
    name: "clone",
    summary: "Make DIR (default ./WORKSPACE) a synced copy of the workspace",
    group: FOLDERS,
    args: [{ name: "WORKSPACE" }, DIR],
    async run({ parsed, print, connect: signIn }) {
      const { client, url } = await signIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ws);
      if (existsSync(dir) && readdirSync(dir).length > 0) throw new UsageError(`${dir} is not empty. Clone into a new or empty folder.`);
      const [info, me] = await Promise.all([client.workspace(ws), client.me()]);
      const state = newState(url, ws, me.user.name || me.user.email.split("@")[0]!);
      await saveState(dir, state);
      const report = await new SyncEngine(dir, client, state).sync();
      print({ dir, workspace: ws, role: info.role, ...report }, () =>
        [`Cloned ${ws} into ${dir} (${report.pulled.length} file(s), you are ${info.role}).`, `Keep it in sync with: fontego watch ${dir}`].join("\n"),
      );
    },
  },
  {
    name: "link",
    summary: "Connect a folder that already has files (default: this one) and send them up",
    group: FOLDERS,
    args: [{ name: "WORKSPACE" }, DIR],
    async run({ parsed, print, connect: signIn }) {
      const { client, url } = await signIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ".");
      if (!existsSync(dir)) throw new UsageError(`${dir} doesn't exist.`);
      const existing = findRoot(dir);
      if (existing) throw new UsageError(`${existing} is already synced with "${(await loadState(existing)).workspace}".`);
      const [info, me] = await Promise.all([client.workspace(ws), client.me()]);
      const state = newState(url, ws, me.user.name || me.user.email.split("@")[0]!);
      await saveState(dir, state);
      const report = await new SyncEngine(dir, client, state).sync();
      print({ dir, workspace: ws, role: info.role, ...report }, () =>
        [
          `Linked ${dir} to ${ws}: ${report.pushed.length} file(s) sent, ${report.pulled.length} received.`,
          ...describeReport(report).filter((l) => !l.startsWith("↑") && !l.startsWith("↓")),
          `Keep it in sync with: fontego watch ${dir}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "status",
    summary: "What changed here since the last sync, and what the ignore rules keep here (works offline)",
    group: FOLDERS,
    args: [DIR],
    flags: [{ name: "ignored", type: "boolean", description: "List what the ignore rules keep here (--json always does)" }],
    async run(rc) {
      const { root, state } = await folder(rc, rc.parsed.args.DIR);
      const st = await localStatus(root, state);
      // A file in the workspace that the rules match keeps syncing; say so, and how to take it out.
      const trackedIgnored = st.trackedIgnored.map((t) => ({ ...t, hash: state.files[t.path]?.hash ?? null }));
      rc.print({ root, workspace: state.workspace, head: state.head, ...st, trackedIgnored }, () => {
        const lines = [
          ...st.added.map((p) => `new       ${p}`),
          ...st.modified.map((p) => `modified  ${p}`),
          ...st.deleted.map((p) => `deleted   ${p}`),
          ...Object.entries(st.skipped).map(([p, s]) => `skipped   ${p}: ${s.reason}`),
          ...(rc.parsed.flags.ignored ? st.ignored.map((p) => `ignored   ${p}`) : []),
        ];
        const notes = trackedIgnored.map(
          (t) =>
            `note: ${t.path} matches ${ruleText(t)} but is in the workspace, so it keeps syncing. To take it out of the workspace (the copy here stays): fontego rm ${state.workspace} ${t.path} --base ${t.hash}`,
        );
        const ignored =
          st.ignored.length && !rc.parsed.flags.ignored
            ? [`${st.ignored.length} ignored here (fontego status --ignored lists them; fontego check-ignore PATH says why).`]
            : [];
        return [`${state.workspace} in ${root}`, lines.length ? lines.join("\n") : "Nothing to send.", ...notes, ...ignored].join("\n");
      });
    },
  },
  {
    name: "check-ignore",
    summary: "Which ignore rule keeps a path from syncing, if any, like git check-ignore -v (works offline)",
    group: FOLDERS,
    args: [{ name: "PATH", description: "A file or folder inside a synced folder" }],
    async run(rc) {
      const given = rc.parsed.args.PATH!;
      const abs = resolve(given);
      const root = findRoot(dirname(abs));
      if (!root) throw new UsageError(`${given} is not inside a synced workspace.`);
      const rel = relative(root, abs).split(sep).join("/");
      if (!rel || rel.startsWith("..")) throw new UsageError(`Give a path inside ${root}.`);
      let isDir = given.endsWith("/");
      try {
        isDir ||= lstatSync(abs).isDirectory();
      } catch {
        // it doesn't exist (yet): check it as a file, or a folder with a trailing /
      }
      const state = await loadState(root);
      const rules = await loadIgnoreRules(root);
      await rules.prepare(rel);
      const m = rules.match(rel, isDir);
      const tracked = !!state.files[rel.normalize("NFC")];
      rc.print({ path: rel, folder: isDir, ...m, tracked }, () => {
        if (!m.ignored) return `${rel} is not ignored.`;
        const why = `${m.source}${m.line ? `:${m.line}` : ""}:${m.pattern}\t${rel}${m.folder ? `  (through the folder ${m.folder}/)` : ""}`;
        return tracked ? `${why}\n${rel} is in the workspace, though, so it keeps syncing. To take it out: fontego rm.` : why;
      });
      // As git check-ignore: 1 when the path isn't ignored.
      if (!m.ignored) process.exitCode = 1;
    },
  },
  {
    name: "sync",
    summary: "Sync once: bring down, send up",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, online } = await folder(rc, rc.parsed.args.DIR);
      const { engine } = await online();
      const release = await acquireLock(root);
      try {
        const r = await engine.sync();
        rc.print({ root, ...r }, () => describeReport(r).join("\n") || "Up to date.");
      } finally {
        await release();
      }
    },
  },
  {
    name: "watch",
    summary: "Keep syncing: seconds after you edit, and when others commit; waits while offline",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state, online } = await folder(rc, rc.parsed.args.DIR);
      const { engine, client, conn } = await online();
      const release = await acquireLock(root);
      const log = (line: string) =>
        rc.json ? console.log(JSON.stringify({ at: new Date().toISOString(), message: line })) : console.log(`${new Date().toLocaleTimeString()}  ${line}`);
      let lastError = "";
      const watcher = new Watcher(engine, client, {
        onReport: (r) => {
          if (lastError) log("carrying on");
          lastError = "";
          if (rc.json && (r.pulled.length || r.pushed.length || r.conflicts.length || r.skipped.length)) {
            console.log(JSON.stringify({ at: new Date().toISOString(), report: r }));
          } else if (!rc.json) for (const l of describeReport(r)) log(l);
        },
        onError: (e) => {
          // Signed out (the session ended, or the token was refused): wait, and say so once.
          const line =
            e instanceof ClientError && e.status === 401
              ? `paused: ${e.message} Sign in again (fontego login ${conn.label}) and it carries on by itself.`
              : `sync failed: ${e.message}`;
          if (line !== lastError) log(line);
          lastError = line;
        },
        onEvent: log,
      });
      const stop = async () => {
        await watcher.stop();
        await release();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      log(`watching ${root} (${state.workspace} on ${conn.label}); Ctrl+C to stop`);
      await watcher.start();
    },
  },
  {
    name: "conflicts",
    summary: "Conflict copies waiting to be merged by hand (works offline)",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state } = await folder(rc, rc.parsed.args.DIR);
      const scanned = await scan(root, await loadIgnoreRules(root), state.files);
      const copies = [...scanned.files.keys()].filter(isConflictCopy).sort();
      rc.print({ root, conflicts: copies }, () => (copies.length ? copies.join("\n") : "No conflict copies."));
    },
  },
];

export const BUILTIN_NAMES = BUILTINS.map((b) => b.name);

/** First words of the built-in commands: a declared command can't start with one. */
export const BUILTIN_WORDS = [...new Set(BUILTIN_NAMES.map((n) => n.split(" ")[0]!))];
