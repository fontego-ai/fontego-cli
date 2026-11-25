import { localDate, SessionName, type Me, type TokenResponse, type TokenScope } from "@fontego/core";
import type { Credential as SavedCredential } from "../config.ts";
import { AGENTS, installed } from "../agents.ts";
import { UsageError, type UsageArg } from "../args.ts";
import {
  browserLogin,
  deviceLogin,
  fetchInstance,
  fromTokenResponse,
  hasBrowser,
  instanceLink,
  machineName,
  openInBrowser,
  openPrivately,
  removeCredential,
  replaceCredential,
  type StillOpen,
} from "../auth.ts";
import { Client } from "../client.ts";
import {
  aliasFor,
  aliasProblem,
  configPath,
  credentialStore,
  defaultAlias,
  forgetInstance,
  instanceByAlias,
  instanceByUrl,
  instanceUrl,
  listInstances,
  plainHttp,
  rememberStore,
  sameInstance,
  renameInstance,
  saveInstance,
  setDefault,
  type CredentialStore,
  type Instance,
} from "../config.ts";
import { ensureMigrated } from "../connect.ts";
import { forgetCommands, refreshCommands } from "../declared.ts";
import { canAsk } from "../output.ts";
import { askText, choose, type Choice } from "../picker.ts";
import { readSecret } from "../prompt.ts";
import { formatTable, terminalWidth } from "../table.ts";
import type { Builtin, RunContext } from "./command.ts";
import { skillInstalled } from "./setup.ts";

const DAY = 86_400_000;
const when = localDate;

/** The browser can't be opened here: sign in with a code instead. */
class NoBrowserHere extends Error {}

/** What a token may do, in words: "only reads in notes", "reads and writes in all your workspaces". */
const reach = (scope: TokenScope) =>
  `${scope.access === "write" ? "reads and writes" : "only reads"} in ${scope.workspaces === "all" ? "all your workspaces" : scope.workspaces.join(", ")}`;

type Status = "active" | "ends soon" | "ended" | "signed out" | "token";

/** How an instance stands on this machine, from what is stored (no network): a token that ended has ended too. */
async function statusOf(i: Instance, store: CredentialStore): Promise<{ status: Status; endsAt: string | null; credential: SavedCredential["type"] | null }> {
  const c: SavedCredential | null = await store.get(i.url);
  if (!c) return { status: "signed out", endsAt: null, credential: null };
  if (c.type === "token") {
    const ended = c.expiresAt !== undefined && Date.parse(c.expiresAt) <= Date.now();
    return { status: ended ? "ended" : "token", endsAt: c.expiresAt ?? null, credential: "token" };
  }
  const left = Date.parse(c.expiresAt) - Date.now();
  return { status: left <= 0 ? "ended" : left < 3 * DAY ? "ends soon" : "active", endsAt: c.expiresAt, credential: "session" };
}

/** One of this machine's Fontegos, picked from its list when left out at a terminal */
const ALIAS: UsageArg = {
  name: "ALIAS",
  pick: {
    local: true,
    async load() {
      await ensureMigrated();
      return listInstances().map((i) => ({ value: i.alias, label: `${i.name} (${i.url})` }));
    },
  },
};

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
  if (!canAsk(rc.json)) throw new UsageError(`fontego login ALIAS or URL. Yours: ${listed()}`);
  const store = await credentialStore();
  const known = await Promise.all(
    all.map(async (i): Promise<Choice> => {
      const st = await statusOf(i, store);
      return { value: i.alias, label: `${i.name} · ${st.status}${st.endsAt ? ` until ${when(st.endsAt)}` : ""}` };
    }),
  );
  const another: Choice = { value: "+", label: "Another Fontego: type its address" };
  const picked = await choose("Sign in to which Fontego?", [...known, another]);
  return picked === another ? askText("Its address (URL)") : picked.value;
}

/** FONTEGO_TOKEN, when FONTEGO_URL says it is this Fontego's: a token exported for one server never goes to another. */
function envToken(url: string, env = process.env): string | undefined {
  return env.FONTEGO_TOKEN && env.FONTEGO_URL && sameInstance(env.FONTEGO_URL, url) ? env.FONTEGO_TOKEN : undefined;
}

/** What stays open on the server, for --json and to tell the person: signing out here doesn't always close it there. */
function leftOpen(alias: string, open: StillOpen, previous = false) {
  const what = previous ? "The previous" : "The";
  const message =
    open.credential === "token"
      ? `${what} token still works on the server: revoke it where it was created if nobody should use it any more.`
      : `${what} session couldn't be closed on the server, which didn't answer. It ends by itself on ${when(open.expiresAt)}, or close it from another device: fontego account sessions close ${open.sessionId}`;
  return { alias, ...open, message };
}

/**
 * A new sign-in replaces the session this machine had there, and when that one is still open the new one takes its
 * name, whatever it was (given at sign-in, renamed in Your account or with fontego account sessions rename, or the
 * computer's name then): it is the same machine. So the computer's name only names a machine's first session, and
 * --name or a rename changes it. Asked with the new session, before the old one closes; nothing happens if it can't be.
 */
async function keepSessionName(url: string, now: Extract<SavedCredential, { type: "session" }>, previous: SavedCredential | null, sent: string): Promise<string | null> {
  if (previous?.type !== "session") return null;
  try {
    const client = new Client(url, now.accessToken);
    const old = (await client.mySessions()).sessions.find((x) => x.id === previous.sessionId);
    if (!old || old.label === sent) return null;
    return (await client.renameSession(now.sessionId, old.label)).label;
  } catch {
    return null;
  }
}

async function signOut(instance: Instance, store: CredentialStore) {
  const open = await removeCredential(instance.url, store);
  forgetCommands(instance.url);
  return open ? leftOpen(instance.alias, open) : null;
}

const MACHINE = "This machine";

export const instanceCommands: Builtin[] = [
  {
    name: "login",
    summary: "Sign in to a Fontego: opens the browser (or shows a code to type on another device)",
    group: MACHINE,
    args: [{ name: "TARGET", optional: true, description: "An alias you already have, or the address of a Fontego" }],
    flags: [
      { name: "device", type: "boolean", description: "Show a code to type in a browser on another device (no browser here)" },
      {
        name: "token",
        type: "string",
        value: "TOKEN",
        description: "Sign in with a token instead, for scripts and CI; --token - reads it from stdin, out of ps and the shell's history (FONTEGO_TOKEN counts only when FONTEGO_URL is this Fontego)",
      },
      { name: "alias", type: "string", value: "ALIAS", description: "The short name to use for this Fontego (default: from its name); one this machine knows takes it as its new alias" },
      {
        name: "name",
        type: "string",
        value: "NAME",
        description: "What this machine's session is called in Your account (default: the computer's name, or the name its last session there had)",
      },
      { name: "allow-http", type: "boolean", description: "Accept a plain http:// address on another machine, remembered for it: passwords and tokens go unencrypted" },
    ],
    async run(rc) {
      await ensureMigrated();
      const target = await loginTarget(rc);
      let known = instanceByAlias(target);
      if (!known && !isUrl(target)) throw new UsageError(`No instance "${target}" on this machine.${listInstances().length ? ` Yours: ${listed()}.` : ""} Give its address: fontego login URL`);
      // Nothing is sent before the address is checked: https, or http on this machine unless accepted.
      const checked = instanceUrl(known?.url ?? target, {
        allowHttp: rc.parsed.flags["allow-http"] === true || known?.allowHttp === true,
        httpHint: `Use its https:// address. If the network is yours and you accept that: fontego login ${target} --allow-http`,
      });
      known ??= instanceByUrl(checked);
      const url = known?.url ?? checked;
      // The alias asked for, checked before anything opens: this Fontego's already, or one no other has.
      const wanted = rc.parsed.flags.alias as string | undefined;
      if (wanted !== undefined) {
        const problem = aliasProblem(wanted);
        if (problem) throw new UsageError(problem);
        const owner = instanceByAlias(wanted);
        if (owner && owner.url !== url) throw new UsageError(`"${wanted}" is already the alias of ${owner.url}.`);
      }
      // The session's name, checked before anything opens too
      const named = rc.parsed.flags.name as string | undefined;
      const nameCheck = named === undefined ? null : SessionName.safeParse(named);
      if (nameCheck && !nameCheck.success) throw new UsageError(`--name ${nameCheck.error.issues[0]?.message ?? "isn't a name"}.`);
      const machine = nameCheck?.data ?? machineName();
      const info = await fetchInstance(url);
      // A Fontego this machine knows under another alias takes the one asked for, once signed in.
      const renamed = known && wanted && wanted !== known.alias ? { from: known.alias, to: wanted } : null;
      const alias = wanted ?? known?.alias ?? aliasFor(info.name, url);
      const store = await credentialStore();
      const say = (data: Record<string, unknown>, text: string) => (rc.json ? console.log(JSON.stringify(data)) : console.error(text));

      let cred: SavedCredential;
      let email: string;
      /** What the session is called, for a sign-in through the browser or with a code */
      let sessionName: string | null = null;
      let tokenCredential: Extract<Me["credential"], { type: "token" }> | null = null;
      const given = rc.parsed.flags.token as string | undefined;
      const token = given === "-" ? await readSecret("TOKEN", rc.json) : (given ?? envToken(url));
      if (token && named !== undefined) {
        const from = given === undefined ? "FONTEGO_TOKEN (with FONTEGO_URL)" : "--token";
        throw new UsageError(`--name names this machine's session, and a token isn't one: sign in without ${from} to name it.`);
      }
      if (token) {
        const me = await new Client(url, token).me();
        email = me.user.email;
        if (me.credential.type === "token") tokenCredential = me.credential;
        cred = { type: "token", token, ...(tokenCredential ? { expiresAt: tokenCredential.expiresAt } : {}) };
      } else {
        const viaCode = () =>
          deviceLogin(url, {
            machine,
            waiting: (d) =>
              say(
                { status: "waiting", verification_uri: d.verification_uri, user_code: d.user_code, verification_uri_complete: d.verification_uri_complete },
                `To sign in to ${info.name}, open ${d.verification_uri} on any device and type the code ${d.user_code}\n(or open ${d.verification_uri_complete})\nWaiting…`,
              ),
          });
        let t: TokenResponse;
        if (rc.parsed.flags.device === true || !hasBrowser()) t = await viaCode();
        else {
          try {
            t = await browserLogin(url, {
              machine,
              waiting: (link) => {
                const opened = openInBrowser(link);
                // Nothing here opens it (no browser program): its link would only work on this machine, so a code
                // typed in a browser anywhere, without anyone having to know about it. "none" only shows links.
                if (!opened && process.env.FONTEGO_BROWSER !== "none") throw new NoBrowserHere();
                say(
                  { status: "waiting", url: link, hint: `Open this link in a browser where you can sign in to ${info.name}.` },
                  `${opened ? "Opening the browser" : "Open this link in your browser"} to sign in to ${info.name}${opened ? "; if it doesn't open, go to" : ""}:\n  ${link}\nWaiting…`,
                );
              },
            });
          } catch (e) {
            if (!(e instanceof NoBrowserHere)) throw e;
            t = await viaCode();
          }
        }
        const session = fromTokenResponse(t);
        cred = session;
        email = t.session.email;
        sessionName = (named === undefined ? await keepSessionName(url, session, await store.get(url), machine) : null) ?? machine;
      }

      // Someone else than before: say so. It may be what the person wanted, or another user of this machine who got
      // their own approval to this sign-in's waiting port first, so the files synced from here would go to them.
      const accountChanged = known?.email && known.email !== email ? { from: known.email, to: email } : null;

      // A new sign-in replaces this machine's previous session there, which closes on the server.
      const previous = await replaceCredential(url, store, cred);
      const stillOpen = previous ? [leftOpen(alias, previous, true)] : [];
      rememberStore(store.kind);
      if (renamed) renameInstance(renamed.from, renamed.to);
      saveInstance({ alias, url, name: info.name, email, addedAt: known?.addedAt ?? new Date().toISOString(), allowHttp: plainHttp(url) });
      const access = cred.type === "token" ? cred.token : cred.accessToken;
      await refreshCommands(new Client(url, access)).catch(() => {});
      const result = {
        ok: true,
        alias,
        url,
        name: info.name,
        user: { email },
        credential: cred.type,
        ...(cred.type === "session" ? { expiresAt: cred.expiresAt } : tokenCredential ? { expiresAt: tokenCredential.expiresAt, scope: tokenCredential.scope } : {}),
        default: defaultAlias() === alias,
        config: configPath(),
        store: store.kind,
        agentSkill: skillInstalled(),
        stillOpen,
        accountChanged,
        renamed,
        ...(sessionName !== null ? { sessionName } : {}),
      };
      if (rc.json) return console.log(JSON.stringify(result));
      console.log(
        cred.type === "session"
          ? `Signed in to ${info.name} (${alias}) as ${email}, on "${sessionName}". The session ends on ${when(cred.expiresAt)} unless you use it before.`
          : `Signed in to ${info.name} (${alias}) as ${email}, with a token${tokenCredential ? `: it ${reach(tokenCredential.scope)} until ${when(tokenCredential.expiresAt)}` : ""}.`,
      );
      if (renamed) console.log(`${renamed.from} is now ${renamed.to}.`);
      if (accountChanged) {
        console.log(`Until now this machine was signed in there as ${accountChanged.from}, not ${accountChanged.to}. If you didn't mean to change accounts, sign in again: fontego login ${alias}`);
      }
      for (const o of stillOpen) console.log(o.message);
      // The first time, say how the agents here learn to use fontego.
      if (!result.agentSkill && AGENTS.some((a) => installed(a))) console.log("To teach the AI agents on this machine to use fontego: fontego setup");
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
      const stillOpen: ReturnType<typeof leftOpen>[] = [];
      for (const i of targets) {
        const open = await signOut(i, store);
        if (open) stillOpen.push(open);
      }
      const names = targets.map((i) => i.alias);
      print({ ok: true, signedOut: names, stillOpen }, () => [`Signed out of ${names.join(", ")}.`, ...stillOpen.map((o) => (targets.length > 1 ? `${o.alias}: ${o.message}` : o.message))].join("\n"));
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
        const cells = rows.map((r) => [r.default ? "*" : "", r.alias, r.name, r.email ?? "", r.status, r.endsAt ? when(r.endsAt) : "", r.url]);
        return `${formatTable(["", "ALIAS", "NAME", "ACCOUNT", "STATUS", "ENDS", "URL"], cells, { width: terminalWidth() })}\n* default`;
      });
    },
  },
  {
    name: "sessions rename",
    summary: "Give a Fontego another alias",
    group: MACHINE,
    args: [ALIAS, { name: "NEW" }],
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
    args: [ALIAS],
    async run({ parsed, print }) {
      await ensureMigrated();
      const i = instanceByAlias(parsed.args.ALIAS!);
      if (!i) throw new UsageError(`No instance "${parsed.args.ALIAS}".`);
      const store = await credentialStore();
      const open = await signOut(i, store);
      forgetInstance(i.alias);
      print({ ok: true, forgot: i.alias, stillOpen: open ? [open] : [] }, () => [`Forgot ${i.alias} (${i.url}).`, ...(open ? [open.message] : [])].join("\n"));
    },
  },
  {
    name: "use",
    summary: "Choose the Fontego commands go to by default",
    group: MACHINE,
    args: [ALIAS],
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
      const { client, url: instance } = await signIn();
      const ws = parsed.args.WORKSPACE;
      if (ws) await client.workspace(ws); // fails early if it doesn't exist for you
      const link = await client.sessionCode();
      // The link carries a code that signs the browser in: it opens only on the instance's own origin.
      const page = instanceLink(link.url, instance);
      const url = ws ? `${page}&next=${encodeURIComponent(`/w/${ws}`)}` : page;
      if (parsed.flags.print === true || json) return print({ url, expiresAt: link.expiresAt }, () => url);
      // Through a private page: on the browser's command line, any user of this machine could read the code first.
      const opened = await openPrivately(url, () => console.log("Opening the web app in your browser (the link works once, for two minutes). If it doesn't open: fontego open --print"));
      if (!opened) console.log(`Open this link in your browser (works once, for two minutes):\n${url}`);
    },
  },
];
