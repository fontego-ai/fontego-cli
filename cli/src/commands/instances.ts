import type { Credential as SavedCredential } from "../config.ts";
import { AGENTS, installed } from "../agents.ts";
import { UsageError, type UsageArg } from "../args.ts";
import { browserLogin, deviceLogin, fetchInstance, fromTokenResponse, hasBrowser, openInBrowser, revokeSession } from "../auth.ts";
import { Client } from "../client.ts";
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
} from "../config.ts";
import { ensureMigrated } from "../connect.ts";
import { forgetCommands, refreshCommands } from "../declared.ts";
import { canAsk } from "../output.ts";
import { askText, choose, type Choice } from "../picker.ts";
import type { Builtin, RunContext } from "./command.ts";
import { skillInstalled } from "./setup.ts";

const DAY = 86_400_000;
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

type Status = "active" | "ends soon" | "ended" | "signed out" | "token";

/** How an instance stands on this machine, from what is stored (no network). */
async function statusOf(i: Instance, store: CredentialStore): Promise<{ status: Status; endsAt: string | null }> {
  const c: SavedCredential | null = await store.get(i.url);
  if (!c) return { status: "signed out", endsAt: null };
  if (c.type === "token") return { status: "token", endsAt: null };
  const left = Date.parse(c.expiresAt) - Date.now();
  return { status: left <= 0 ? "ended" : left < 3 * DAY ? "ends soon" : "active", endsAt: c.expiresAt };
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

async function signOut(instance: Instance, store: CredentialStore) {
  const credential = await store.get(instance.url);
  if (credential?.type === "session") await revokeSession(instance.url, credential.refreshToken);
  await store.delete(instance.url);
  forgetCommands(instance.url);
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
        agentSkill: skillInstalled(),
      };
      if (rc.json) return console.log(JSON.stringify(result));
      console.log(
        cred.type === "session"
          ? `Signed in to ${info.name} (${alias}) as ${email}. The session ends on ${when(cred.expiresAt)} unless you use it before.`
          : `Signed in to ${info.name} (${alias}) as ${email}, with a token.`,
      );
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
      for (const i of targets) await signOut(i, store);
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
      await signOut(i, store);
      forgetInstance(i.alias);
      print({ ok: true, forgot: i.alias }, () => `Forgot ${i.alias} (${i.url}).`);
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
];
