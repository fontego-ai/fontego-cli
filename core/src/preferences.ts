// What each person chooses for themselves on a Fontego, kept with their account so it follows them to any browser or
// machine (GET /v1/me/preferences). A closed list: each preference has its schema, its default and what it is for,
// shared by the server, the web app and the CLI. It is never a place to keep anything else.

import { z } from "zod";
import { WORKSPACE_SLUG } from "./schemas.ts";

/** How many workspaces someone can pin. */
export const MAX_PINNED = 50;

/** How a workspace's files show in the web app: a grid of folders to go in and out of, or the tree of an IDE. */
export const FILES_VIEWS = ["grid", "tree"] as const;
export type FilesView = (typeof FILES_VIEWS)[number];

interface PreferenceDef<S extends z.ZodType> {
  description: string;
  schema: S;
  default: z.output<S>;
}

const define = <S extends z.ZodType>(def: PreferenceDef<S>) => def;

export const PREFERENCES = {
  pinned: define({
    description: "Workspaces pinned in the web app's sidebar, in their order",
    schema: z
      .array(z.string().regex(WORKSPACE_SLUG, "is not a workspace id"))
      .max(MAX_PINNED, `pin at most ${MAX_PINNED} workspaces`),
    default: [],
  }),
  filesView: define({
    description: "How a workspace's files show in the web app: grid (folders to go in and out of) or tree",
    schema: z.enum(FILES_VIEWS, "is grid or tree"),
    default: "grid",
  }),
};

export type PreferenceKey = keyof typeof PREFERENCES;
export type Preferences = { [K in PreferenceKey]: z.output<(typeof PREFERENCES)[K]["schema"]> };

export const PREFERENCE_KEYS = Object.keys(PREFERENCES) as PreferenceKey[];

export const isPreferenceKey = (key: string): key is PreferenceKey => Object.hasOwn(PREFERENCES, key);

/**
 * A value for a preference, from JSON or from text (the CLI sends text: a list as names split on commas or new
 * lines). Lists lose their repeats and keep their order. Returns what is wrong with it, for people, when it doesn't fit.
 */
export function parsePreference<K extends PreferenceKey>(key: K, raw: unknown): { value: Preferences[K] } | { problem: string } {
  const def = PREFERENCES[key];
  let v = raw;
  const isList = def.schema instanceof z.ZodArray;
  if (isList && typeof v === "string") v = v.split(/[,\n]/);
  if (isList && Array.isArray(v)) v = [...new Set(v.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== ""))];
  else if (typeof v === "string") v = v.trim();
  const r = def.schema.safeParse(v);
  if (r.success) return { value: r.data as Preferences[K] };
  const issue = r.error.issues[0]!;
  const at = issue.path.length ? `${issue.path.map((p) => (typeof p === "number" ? `item ${p + 1}` : String(p))).join(".")}: ` : "";
  return { problem: `${at}${issue.message}` };
}
