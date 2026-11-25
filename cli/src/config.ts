// The servers (instances) this machine signs in to, and where their credentials are kept.
//
// $XDG_CONFIG_HOME/fontego/config.json lists the instances, each under a short alias, and which one is the default.
// It holds no secrets. The credentials (a session's tokens, or a token pasted with --token) go to the system keychain
// (Bun.secrets: Keychain on macOS, the Secret Service of GNOME or KDE, Windows' Credential Manager) or, where there is
// none, to credentials.json next to it with mode 0600. FONTEGO_CREDENTIAL_STORE=file|keychain forces one.
//
// FONTEGO_URL with FONTEGO_TOKEN uses that server and token without touching any of this (scripts, CI).
//
// An instance's address is https, or plain http only to this machine (loopback) unless the person accepted it for that
// instance (fontego login --allow-http) or for FONTEGO_URL (FONTEGO_ALLOW_HTTP=1): over plain http every password,
// token and refresh token would cross the network as it is.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { ClientError } from "./client.ts";

export interface Instance {
  alias: string;
  url: string;
  /** The server's visible name */
  name: string;
  /** Who signed in there, last time */
  email: string | null;
  addedAt: string;
  /** Plain http to another machine, accepted by the person when signing in (fontego login --allow-http) */
  allowHttp?: boolean;
}

interface Registry {
  version: 2;
  default: string | null;
  /** Where credentials live on this machine, decided at the first sign-in */
  store: "keychain" | "file" | null;
  instances: Record<string, Omit<Instance, "alias">>;
}

export type Credential =
  | {
      type: "session";
      accessToken: string;
      accessExpiresAt: string;
      refreshToken: string;
      sessionId: number;
      /** When the session ends if nothing else happens */
      expiresAt: string;
      email: string;
    }
  | {
      type: "token";
      token: string;
      /** When it stops working, as the server said (from /me at sign-in, or its fontego-token-expires header) */
      expiresAt?: string;
    };

export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** This machine only (127.0.0.0/8, ::1, localhost), where plain http never crosses a network. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Whether an address is plain http to another machine. */
export function plainHttp(url: string): boolean {
  const u = new URL(url);
  return u.protocol === "http:" && !isLoopback(u.hostname);
}

/**
 * A Fontego's address as this machine keeps it: its origin and path, without a trailing slash. Refused: what isn't
 * http(s), a user name or password (https://good.example@evil.example goes to evil.example), a query or fragment, and
 * plain http to another machine unless `allowHttp`; `httpHint` says how to accept it where the address came from.
 */
export function instanceUrl(input: string, opts: { allowHttp?: boolean; httpHint?: string } = {}): string {
  const bad = (message: string) => new ClientError(400, "bad_url", message, "Give the address you open in the browser, such as https://fontego.example.org");
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw bad(`"${input}" isn't an address.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad(`${u.protocol} addresses aren't Fontegos: only https:// (or http:// on this machine).`);
  if (u.username || u.password) throw bad(`That address has a user name or password before ${u.host}, the server it would really go to.`);
  if (u.search || u.hash) throw bad(`A Fontego's address has no ?query or #fragment: ${u.origin}${u.pathname}`);
  const url = u.origin + u.pathname.replace(/\/+$/, "");
  if (plainHttp(url) && !opts.allowHttp) {
    throw new ClientError(400, "insecure_url", `${url} is plain http: passwords and tokens would cross the network unencrypted.`, opts.httpHint ?? "Use its https:// address.");
  }
  return url;
}

/** Whether two addresses are the same Fontego (both as instanceUrl keeps them); false if either isn't an address. */
export function sameInstance(a: string, b: string): boolean {
  try {
    return instanceUrl(a, { allowHttp: true }) === instanceUrl(b, { allowHttp: true });
  } catch {
    return false;
  }
}

export const configDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fontego");
export const configPath = (env = process.env) => join(configDir(env), "config.json");
const credentialsPath = (env = process.env) => join(configDir(env), "credentials.json");

/** Our folder, private: made 0700, and closed again if it is ours but others can look in (made by hand, or umask). */
function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const st = statSync(dir);
  if (st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function writePrivate(path: string, data: unknown) {
  privateDir(dirname(path));
  // A name nobody can guess, and only a new file (wx): a file or link someone left there first is never written through.
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// --- the registry ---

function emptyRegistry(): Registry {
  return { version: 2, default: null, store: null, instances: {} };
}

function readRegistry(env = process.env): Registry & { legacy?: { url: string; token: string } } {
  const path = configPath(env);
  if (!existsSync(path)) return emptyRegistry();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Registry> & { url?: string; token?: string };
  if (raw.version === 2) return { ...emptyRegistry(), ...raw } as Registry;
  // Version 1 was a single login: { url, token }. It becomes the first instance (see migrateLegacy).
  return { ...emptyRegistry(), ...(raw.url && raw.token ? { legacy: { url: raw.url, token: raw.token } } : {}) };
}

function writeRegistry(r: Registry, env = process.env) {
  writePrivate(configPath(env), { version: 2, default: r.default, store: r.store, instances: r.instances });
}

export function listInstances(env = process.env): Instance[] {
  const r = readRegistry(env);
  return Object.entries(r.instances).map(([alias, i]) => ({ alias, ...i }));
}

export function defaultAlias(env = process.env): string | null {
  const r = readRegistry(env);
  if (r.default && r.instances[r.default]) return r.default;
  const all = Object.keys(r.instances);
  return all.length === 1 ? all[0]! : null;
}

export function instanceByAlias(alias: string, env = process.env): Instance | null {
  const i = readRegistry(env).instances[alias];
  return i ? { alias, ...i } : null;
}

export function instanceByUrl(url: string, env = process.env): Instance | null {
  return listInstances(env).find((i) => normalizeUrl(i.url) === normalizeUrl(url)) ?? null;
}

/** A short alias from a server's name: "Crumb & Co." → crumb-co. Unique on this machine. */
export function aliasFor(name: string, url: string, env = process.env): string {
  const existing = instanceByUrl(url, env);
  if (existing) return existing.alias;
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!base) base = "fontego";
  const taken = new Set(listInstances(env).map((i) => i.alias));
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
  return alias;
}

export function saveInstance(i: Instance, opts: { makeDefault?: boolean } = {}, env = process.env) {
  const r = readRegistry(env);
  r.instances[i.alias] = { url: normalizeUrl(i.url), name: i.name, email: i.email, addedAt: i.addedAt, ...(i.allowHttp ? { allowHttp: true } : {}) };
  if (opts.makeDefault || !r.default || !r.instances[r.default]) r.default = i.alias;
  writeRegistry(r, env);
}

/** Who is signed in to an instance, as the server says now: a server admin may have changed their address. */
export function setInstanceEmail(alias: string, email: string, env = process.env) {
  const r = readRegistry(env);
  const i = r.instances[alias];
  if (!i || i.email === email) return;
  i.email = email;
  writeRegistry(r, env);
}

export function setDefault(alias: string, env = process.env) {
  const r = readRegistry(env);
  if (!r.instances[alias]) throw new Error(`No instance "${alias}".`);
  r.default = alias;
  writeRegistry(r, env);
}

/** What is wrong with an alias, or null: lowercase letters, digits and dashes, 32 at most. */
export const aliasProblem = (alias: string): string | null =>
  /^[a-z0-9][a-z0-9-]{0,31}$/.test(alias) ? null : `"${alias}" can't be an alias: an alias is lowercase letters, digits and dashes (32 at most).`;

export function renameInstance(from: string, to: string, env = process.env) {
  const r = readRegistry(env);
  if (!r.instances[from]) throw new Error(`No instance "${from}".`);
  if (r.instances[to]) throw new Error(`"${to}" is already the alias of ${r.instances[to]!.url}.`);
  const problem = aliasProblem(to);
  if (problem) throw new Error(problem);
  r.instances[to] = r.instances[from]!;
  delete r.instances[from];
  if (r.default === from) r.default = to;
  writeRegistry(r, env);
}

export function forgetInstance(alias: string, env = process.env) {
  const r = readRegistry(env);
  delete r.instances[alias];
  if (r.default === alias) r.default = Object.keys(r.instances)[0] ?? null;
  writeRegistry(r, env);
}

// --- credentials ---

export interface CredentialStore {
  readonly kind: "keychain" | "file";
  get(url: string): Promise<Credential | null>;
  set(url: string, c: Credential): Promise<void>;
  delete(url: string): Promise<void>;
}

const SERVICE = "fontego";

const keychain: CredentialStore = {
  kind: "keychain",
  async get(url) {
    const v = await Bun.secrets.get({ service: SERVICE, name: normalizeUrl(url) });
    return v ? (JSON.parse(v) as Credential) : null;
  },
  async set(url, c) {
    await Bun.secrets.set({ service: SERVICE, name: normalizeUrl(url), value: JSON.stringify(c) });
  },
  async delete(url) {
    await Bun.secrets.delete({ service: SERVICE, name: normalizeUrl(url) });
  },
};

function fileStore(env = process.env): CredentialStore {
  const path = credentialsPath(env);
  const read = (): Record<string, Credential> => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Credential>) : {});
  return {
    kind: "file",
    async get(url) {
      return read()[normalizeUrl(url)] ?? null;
    },
    async set(url, c) {
      writePrivate(path, { ...read(), [normalizeUrl(url)]: c });
    },
    async delete(url) {
      const all = read();
      delete all[normalizeUrl(url)];
      if (Object.keys(all).length) writePrivate(path, all);
      else rmSync(path, { force: true });
    },
  };
}

/** Whether the keychain answers here (a desktop session); a server over SSH usually has none. */
async function keychainWorks(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), 3000)));
    await Promise.race([Bun.secrets.get({ service: SERVICE, name: "probe" }), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The store of this machine: the one forced by FONTEGO_CREDENTIAL_STORE, the one chosen before, or the keychain if it works. */
export async function credentialStore(env = process.env): Promise<CredentialStore> {
  const forced = env.FONTEGO_CREDENTIAL_STORE;
  if (forced === "file") return fileStore(env);
  if (forced === "keychain") return keychain;
  const r = readRegistry(env);
  if (r.store) return r.store === "keychain" ? keychain : fileStore(env);
  const kind = (await keychainWorks()) ? "keychain" : "file";
  if (Object.keys(r.instances).length || existsSync(configPath(env))) writeRegistry({ ...r, store: kind }, env);
  return kind === "keychain" ? keychain : fileStore(env);
}

/** Remembers the store once there is something to keep. */
export function rememberStore(kind: "keychain" | "file", env = process.env) {
  const r = readRegistry(env);
  if (r.store !== kind) writeRegistry({ ...r, store: kind }, env);
}

/** The login of the first version, { url, token } in config.json, if it is still there. */
export function legacyLogin(env = process.env): { url: string; token: string } | null {
  return readRegistry(env).legacy ?? null;
}

/** Turns the first version's login into an instance, its token into the credential store. */
export async function migrateLegacy(name: string, env = process.env): Promise<Instance | null> {
  const legacy = legacyLogin(env);
  if (!legacy) return null;
  const store = await credentialStore(env);
  const alias = aliasFor(name, legacy.url, env);
  const instance: Instance = { alias, url: normalizeUrl(legacy.url), name, email: null, addedAt: new Date().toISOString() };
  await store.set(instance.url, { type: "token", token: legacy.token });
  writeRegistry({ ...emptyRegistry(), store: store.kind, default: alias, instances: { [alias]: { url: instance.url, name, email: null, addedAt: instance.addedAt } } }, env);
  return instance;
}

// --- a lock, so two processes don't swap the same refresh token ---

/** How long one waits for the lock: longer than anyone holds it, since a renewal gives up on the server sooner */
const LOCK_WAIT_MS = 30_000;
/** A lock this old outlived anything done under it, even if its process number now belongs to another program */
const LOCK_STALE_MS = 5 * 60_000;

const readOrNull = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Whether a lock was left behind: the process that took it is gone (only knowable on this machine: a config folder
 * may be shared), or it is older than anything done under it. A lock still being written, or of unknown owner, is held.
 */
function abandoned(path: string, raw: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false; // gone already: just try again
  }
  if (age > LOCK_STALE_MS) return true;
  let owner: { pid?: unknown; host?: unknown };
  try {
    const parsed = JSON.parse(raw) as unknown;
    owner = typeof parsed === "number" ? { pid: parsed } : (parsed as typeof owner); // the first versions wrote the pid alone
  } catch {
    return false;
  }
  if (typeof owner.pid !== "number" || (owner.host !== undefined && owner.host !== hostname())) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Runs fn holding the named lock of this machine's config folder: one process at a time, across processes. */
export async function withLock<T>(name: string, fn: () => Promise<T>, env = process.env): Promise<T> {
  const path = join(configDir(env), "locks", `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.lock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), id: randomBytes(8).toString("hex") });
  for (const start = Date.now(); ; ) {
    try {
      writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw e;
    }
    const raw = readOrNull(path);
    // Taken away only if it is still the same abandoned lock: another waiter may have just put its own there.
    if (raw !== null && abandoned(path, raw) && readOrNull(path) === raw) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() - start > LOCK_WAIT_MS) {
      throw new ClientError(423, "locked", "Another fontego is still renewing the session.", `Run it again in a moment. If this keeps happening and no other fontego runs, remove ${path}`);
    }
    await Bun.sleep(100);
  }
  try {
    return await fn();
  } finally {
    // Only our own: if it was ever taken from us, the lock there now is someone else's.
    if (readOrNull(path) === mine) rmSync(path, { force: true });
  }
}
