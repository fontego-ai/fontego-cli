// Which instance a command talks to, and a client signed in there. In this order:
//   1. FONTEGO_URL with FONTEGO_TOKEN (scripts, CI): that server, that token;
//   2. --instance ALIAS, then FONTEGO_INSTANCE;
//   3. inside a synced folder, the instance it belongs to (its .fontego/state.json keeps the URL);
//   4. the default instance (fontego use ALIAS), or the only one.
// Either way the address is checked before anything is sent (instanceUrl): https, or http on this machine unless
// accepted (FONTEGO_ALLOW_HTTP=1 for FONTEGO_URL, fontego login --allow-http for an instance).

import { UsageError } from "./args.ts";
import { fetchInstance, StoredAuth } from "./auth.ts";
import { Client, ClientError } from "./client.ts";
import {
  credentialStore,
  defaultAlias,
  instanceByAlias,
  instanceByUrl,
  instanceUrl,
  legacyLogin,
  listInstances,
  migrateLegacy,
  normalizeUrl,
  type Instance,
} from "./config.ts";

export interface Connection {
  instance: Instance | null;
  url: string;
  client: Client;
  /** The stored credential, when the instance is one of this machine's (not FONTEGO_URL/FONTEGO_TOKEN) */
  auth: StoredAuth | null;
  /** How to name it to the person: its alias, or its URL */
  label: string;
}

/** The first version kept one login in config.json; it becomes the first instance, its token goes to the keychain. */
export async function ensureMigrated(env = process.env): Promise<void> {
  const legacy = legacyLogin(env);
  if (!legacy) return;
  const name = await fetchInstance(legacy.url).then(
    (i) => i.name,
    () => new URL(legacy.url).hostname,
  );
  await migrateLegacy(name, env);
}

const listed = () =>
  listInstances()
    .map((i) => `${i.alias} (${i.url})`)
    .join(", ");

export const notSignedIn = (target?: string) =>
  new ClientError(
    401,
    "not_logged_in",
    target ? `You aren't signed in to ${target}.` : "You aren't signed in to any Fontego.",
    `Run: fontego login ${target ?? "URL"} (or set FONTEGO_URL and FONTEGO_TOKEN).`,
  );

export async function connect(opts: { alias?: string; folderUrl?: string } = {}, env = process.env): Promise<Connection> {
  if (env.FONTEGO_URL && env.FONTEGO_TOKEN) {
    const url = instanceUrl(env.FONTEGO_URL, {
      allowHttp: env.FONTEGO_ALLOW_HTTP === "1",
      httpHint: "Use its https:// address, or set FONTEGO_ALLOW_HTTP=1 if the network is yours and you accept that.",
    });
    if (opts.folderUrl && normalizeUrl(opts.folderUrl) !== url) {
      throw new UsageError(`This folder belongs to ${opts.folderUrl}, but FONTEGO_URL is ${url}.`);
    }
    return { instance: null, url, client: new Client(url, env.FONTEGO_TOKEN), auth: null, label: url };
  }
  await ensureMigrated(env);

  const alias = opts.alias || env.FONTEGO_INSTANCE || undefined;
  let instance: Instance | null;
  if (alias) {
    instance = instanceByAlias(alias, env);
    if (!instance) throw new UsageError(`No instance "${alias}" on this machine.${listInstances().length ? ` Yours: ${listed()}.` : ""} Add one with: fontego login URL`);
    if (opts.folderUrl && normalizeUrl(opts.folderUrl) !== instance.url) {
      throw new UsageError(`This folder belongs to ${opts.folderUrl}, not to ${alias} (${instance.url}).`);
    }
  } else if (opts.folderUrl) {
    instance = instanceByUrl(opts.folderUrl, env);
    if (!instance) throw notSignedIn(opts.folderUrl);
  } else {
    const d = defaultAlias(env);
    if (!d) {
      if (listInstances(env).length > 1) {
        throw new UsageError(`Several instances and none is the default: ${listed()}. Choose one with --instance ALIAS, or: fontego use ALIAS`);
      }
      throw notSignedIn();
    }
    instance = instanceByAlias(d, env)!;
  }

  instanceUrl(instance.url, {
    allowHttp: instance.allowHttp,
    httpHint: `If the network is yours and you accept that, sign in again with: fontego login ${instance.alias} --allow-http`,
  });
  const store = await credentialStore(env);
  const cred = await store.get(instance.url);
  if (!cred) throw notSignedIn(instance.alias);
  const auth = new StoredAuth(instance, store, cred);
  return { instance, url: instance.url, client: new Client(instance.url, auth), auth, label: instance.alias };
}
