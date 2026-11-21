// What every request of the API (version 1) may carry. The server validates each request against these schemas, and
// the request types clients use come from them, so a client and the server can't disagree on what a request is.

import { z } from "zod";
import { normalizeTags } from "./tags.ts";

export const ROLES = ["reader", "editor", "admin"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Git file modes the API accepts. */
export const FILE_MODES = ["100644", "100755", "120000"] as const;
export const FileModeSchema = z.enum(FILE_MODES);
export type FileMode = z.infer<typeof FileModeSchema>;

/** A workspace id: lowercase letters, digits and dashes, starting with a letter or a digit. */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+$/;

const Slug = z.string().regex(WORKSPACE_SLUG, "use lowercase letters, digits and dashes, starting with a letter or a digit");
const Email = z.string().trim().regex(EMAIL, "is not an email address");
/**
 * Text never holds control characters (but tab and newline), a carriage return that doesn't end a line, or the bidi
 * controls that reorder what is shown: they mean nothing in a name or a message, and in a terminal they can clear the
 * screen, fake a line or set the clipboard. A line (a name, a label) holds no tab or line break either.
 */
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/;
const Text = (max: number) => z.string().max(max).refine((s) => !CONTROL_TEXT.test(s), "can't hold control characters");
const Line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "must be one line, without control characters");

// --- Workspaces and members ---

/** A category's name is at most this long; an instance may fix the list (setting workspaces.categories). */
export const MAX_CATEGORY = 100;

/** A template's name: what `fontego workspace templates` lists. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * A workspace's tags: a JSON list, or text with the tags split by commas or new lines (what the CLI sends; empty text
 * is no tags). Each is written the way it is kept (normalizeTag), repeats go, the order stays.
 */
export const TagList = z.union([z.array(z.string().max(200)).max(100), z.string().max(4000)]).transform((value, ctx) => {
  const r = normalizeTags(value);
  if ("problem" in r) {
    ctx.addIssue({ code: "custom", message: r.problem });
    return z.NEVER;
  }
  return r.tags;
});

/**
 * A workspace's icon: one of core's list (icons.ts), which the server checks so that a wrong one says which are
 * there. Null, empty or "none" is no icon.
 */
const IconName = z.string().max(40).nullable();

/**
 * A new workspace starts empty, from a template, or from a Git repository the server can reach (https), with its
 * history unless `history` is false. Importing a folder from your machine is `fontego link` on an empty workspace.
 */
export const CreateWorkspaceBody = z
  .object({
    slug: Slug,
    name: Line(200).optional(),
    description: Text(5000).optional(),
    category: Line(MAX_CATEGORY).optional(),
    template: z.string().regex(TEMPLATE_NAME, "is not a template name").optional(),
    git: Line(2000).optional(),
    branch: Line(200).optional(),
    history: z.boolean().optional(),
    /** Given, they win over the template's (also to say none) */
    icon: IconName.optional(),
    tags: TagList.optional(),
  })
  .refine((b) => !(b.template && b.git), { message: "start from a template or from a Git repository, not both", path: ["template"] })
  .refine((b) => b.git || (b.branch === undefined && b.history === undefined), { message: "branch and history only go with git", path: ["branch"] });
export type CreateWorkspaceRequest = z.input<typeof CreateWorkspaceBody>;

export const UpdateWorkspaceBody = z.object({
  name: Line(200).optional(),
  description: Text(5000).optional(),
  category: Line(MAX_CATEGORY).optional(),
  icon: IconName.optional(),
  /** The whole list, in its order: also to reorder or empty it */
  tags: TagList.optional(),
});
export type UpdateWorkspaceRequest = z.input<typeof UpdateWorkspaceBody>;

export const SetMemberBody = z.object({ role: RoleSchema });

/** The line that says what goes in a top-level folder: one line, so it fits on the folder's tile and in `fontego ls`. */
export const MAX_FOLDER_DESCRIPTION = 300;
/** How many folders of one workspace can have a description. */
export const MAX_FOLDER_DESCRIPTIONS = 100;

export const FolderDescriptionBody = z.object({
  description: z
    .string()
    .trim()
    .min(1, "write what goes in the folder (to take its description away: fontego workspace folders unset)")
    .max(MAX_FOLDER_DESCRIPTION, `use at most ${MAX_FOLDER_DESCRIPTION} characters`)
    .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "use one line, without line breaks, tabs or control characters"),
});

// --- People, passwords and tokens ---

/** At least 8 characters, the floor of NIST SP 800-63B; failed sign-ins are throttled (accounts/). Longer is welcome. */
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;
const NewPassword = z
  .string()
  .min(MIN_PASSWORD, `use at least ${MIN_PASSWORD} characters (a few words make a good one)`)
  .max(MAX_PASSWORD, `use at most ${MAX_PASSWORD} characters`);

export const CreateUserBody = z.object({
  email: Email,
  name: Line(200).optional(),
  isAdmin: z.boolean().optional(),
});

export const CreateTokenBody = z.object({
  label: Line(200).optional(),
  kind: z.enum(["person", "agent"]).optional(),
});

/** A person's name, as others see it beside what they change: never empty once it is changed. */
const PersonName = z
  .string()
  .trim()
  .min(1, "can't be empty")
  .max(200, "use at most 200 characters")
  .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "must be one line, without control characters");

/**
 * What a person's photo may be when it comes in, the same for the server, the web and the CLI: a PNG, JPEG or WebP
 * (known by its bytes, never by a name or a header; never an SVG, which can carry code), of at most `maxBytes` and
 * `maxPixels`. The server keeps the square in the middle, `side` pixels a side, as WebP, with nothing else the file
 * carried (where it was taken, the camera...).
 */
export const PHOTO_LIMITS = { maxBytes: 20 * 1024 * 1024, maxPixels: 50_000_000, side: 256 } as const;

/**
 * A file's bytes in JSON: base64 with its padding. Checked as characters plus the length, never with groups, which a
 * regular expression engine can give up on over megabytes.
 */
export const isBase64 = (s: string) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

/** A photo as it comes in: the image file's bytes, in base64. Its size and kind are checked by the server (PHOTO_LIMITS). */
const PhotoBytes = z.string().min(1, "send the image file's bytes, in base64").refine(isBase64, "send the image file's bytes, in base64");

/** Someone's photo: `v`, the version an answer gave with its address; with the one of now it can be kept for good */
export const PhotoQuery = z.object({ v: z.string().regex(/^[0-9a-f]{1,64}$/, "is a photo's version, as photoUrl gives it").optional() });

/**
 * Your own account: what you may change yourself. A photo is its bytes, or null to remove it. The email is changed by
 * a server admin (UpdateUserBody).
 */
export const UpdateMeBody = z
  .object({ name: PersonName.optional(), photo: PhotoBytes.nullable().optional() })
  .refine((b) => b.name !== undefined || b.photo !== undefined, {
    message: "say what to change: a name (--name), a photo (--photo FILE, or --photo none to remove it) or both",
  });
export type UpdateMeRequest = z.input<typeof UpdateMeBody>;

/**
 * A server admin changes someone's name or email, or removes their photo (null). The email is what they sign in
 * with. A photo is only ever set by its owner.
 */
export const UpdateUserBody = z
  .object({
    name: PersonName.optional(),
    email: Email.optional(),
    photo: z.null({ error: "a server admin can only remove a photo (--photo none); each person sets their own (fontego account set --photo FILE)" }).optional(),
  })
  .refine((b) => b.name !== undefined || b.email !== undefined || b.photo !== undefined, {
    message: "say what to change: a name (--name), an email (--email), the photo (--photo none) or several",
  });
export type UpdateUserRequest = z.input<typeof UpdateUserBody>;

/** Invites someone: creates their account, without a password, and sends them a one-time link to set one. */
export const InviteBody = z.object({
  email: Email,
  name: Line(200).optional(),
  admin: z.boolean().optional(),
});

/** Uses a one-time link (set up the first admin, accept an invitation, reset a password): the new password. */
export const UseLinkBody = z.object({ password: NewPassword, name: Line(200).optional() });

/** Asks for a link to set a new password. The answer is the same whether the address has an account or not. */
export const PasswordResetBody = z.object({ email: Email });

export const MailTestBody = z.object({ to: Email });

// --- Your own preferences (preferences.ts lists them) ---

/** A new value for one of your preferences: its type in JSON, or text (a list as names split on commas). */
export const PreferenceValueBody = z.object({ value: z.union([z.string(), z.array(z.string())], "a value is required") });

// --- OAuth, for the CLI to sign in through the browser. Field names are the standard's (RFC 6749, 7636, 8628). ---

/** The person's answer, from a signed-in browser, to "connect the CLI of <machine>?" */
export const AuthorizeBody = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.string(),
  state: z.string().max(500).optional(),
  machine: Line(80).optional(),
  approve: z.boolean(),
});

export const DeviceStartBody = z.object({ client_id: z.string(), machine: Line(80).optional() });

export const DeviceDecisionBody = z.object({ approve: z.boolean() });

export const TokenBody = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("authorization_code"), code: z.string(), code_verifier: z.string(), redirect_uri: z.string(), client_id: z.string() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string(), client_id: z.string().optional() }),
  z.object({ grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"), device_code: z.string(), client_id: z.string() }),
]);

export const RevokeBody = z.object({ token: z.string(), token_type_hint: z.string().optional() });

/** Opens a browser session: with email and password, a token, or a one-time code from `fontego open`. */
export const SessionBody = z.union([
  z.object({ email: z.string(), password: z.string().max(MAX_PASSWORD) }),
  z.object({ token: z.string() }),
  z.object({ code: z.string() }),
]);

// --- Reading ---

/** Query values arrive as text; a flag is on with "1" or "true". */
const Flag = z.string().optional();
const Opt = z.string().optional();

/** tag: the workspaces with every one of these tags (split by commas), written as they are kept or not */
export const WorkspacesQuery = z.object({ category: Opt, tag: TagList.optional() });
/** last=1: each entry's last change (TreeEntry.last) */
export const TreeQuery = z.object({ path: Opt, rev: Opt, recursive: Flag, last: Flag });
export const FileQuery = z.object({ rev: Opt, meta: Flag, download: Flag });
/** files=1: each commit's files (Commit.files) */
export const HistoryQuery = z.object({ path: Opt, rev: Opt, limit: Opt, files: Flag });

/**
 * The changes of every workspace someone can read, newest first. `person` is an account's id or an email (an email
 * no account has finds that author as is); `kind` keeps the changes made by people (no agent) or by agents;
 * archived workspaces only come with archived=1 or when named in `workspace`; `cursor` is the `next` of the answer
 * before.
 */
export const ActivityQuery = z.object({
  workspace: Opt,
  person: Opt,
  kind: z.enum(["people", "agents"], "is people or agents").optional(),
  archived: Flag,
  files: Flag,
  limit: Opt,
  cursor: Opt,
});
export type ActivityRequest = z.input<typeof ActivityQuery>;
export const SyncQuery = z.object({ since: Opt });
export const SearchQuery = z.object({ q: z.string(), path: Opt, limit: Opt });

// --- Live: who is in each workspace now ---

export const PRESENCE_ACTIVITIES = ["reading", "editing", "working"] as const;
/** How long an announcement lasts without being renewed, in minutes */
export const PRESENCE_MINUTES = { default: 15, max: 120 } as const;

/** Who is around: in every workspace you read, or in one */
export const PresenceQuery = z.object({ workspace: Opt });

/**
 * Announcing yourself in a workspace. A tab of a client (`tab`, its own id) is in one workspace at a time and renews
 * itself; without one, the announcement is the caller's credential and agent's, and repeating it renews it.
 */
export const SetPresenceBody = z.object({
  activity: z.enum(PRESENCE_ACTIVITIES).default("working"),
  /** A file, or a folder ending in / */
  path: Line(1024).optional(),
  tab: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "use 8 to 64 letters, digits, - or _").optional(),
  minutes: z.number().int().min(1).max(PRESENCE_MINUTES.max).default(PRESENCE_MINUTES.default),
});
export type SetPresenceRequest = z.input<typeof SetPresenceBody>;

export const ClearPresenceQuery = z.object({ tab: Opt });

// --- For server admins ---

/** A destructive action says yes on purpose. */
export const ConfirmBody = z.object({ confirm: z.literal(true, "add --yes: this can't be undone") });

/** Lists for admins, maybe of one person */
export const ByUserQuery = z.object({ user: Opt });

export const AuditQuery = z.object({ user: Opt, workspace: Opt, since: Opt, limit: Opt });

/** A new value for one of the instance's settings; the server checks it against the setting's type. */
export const SettingValueBody = z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())], "a value is required") });

/** Going back to the instance's default path rules: both kinds, or one. */
export const PathRulesResetQuery = z.object({ kind: z.enum(["protected", "rejected"]).optional() });

/** Deleting a workspace for good: its id, typed again. */
export const DeleteWorkspaceBody = z.object({ confirm: z.string().optional() });

// --- Writing: a change set is a list of operations on whole files ---

export const MAX_OPS = 1000;

export const PutOpSchema = z.object({
  op: z.literal("put"),
  path: z.string(),
  /** UTF-8 text; use contentBase64 for binary files and for any bytes a UTF-8 string wouldn't give back exactly (core: textContent) */
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  /** Git blob hash of the version this edit started from; null for a new file */
  baseHash: z.string().nullable(),
  mode: FileModeSchema.optional(),
});

export const DeleteOpSchema = z.object({ op: z.literal("delete"), path: z.string(), baseHash: z.string() });

export const MoveOpSchema = z.object({ op: z.literal("move"), from: z.string(), to: z.string(), baseHash: z.string() });

export const ChangeOpSchema = z.discriminatedUnion("op", [PutOpSchema, DeleteOpSchema, MoveOpSchema]);

export const ChangeSetBody = z.object({
  /** The commit the client last synced; the base for three-way merges */
  baseCommit: z.string().nullable().default(null),
  message: Text(10_000).default(""),
  ops: z.array(ChangeOpSchema).min(1, "send at least one operation").max(MAX_OPS, `split it: at most ${MAX_OPS} operations`),
  /** Free label of the client: "fontego", "web", "script"... */
  client: Line(40).optional(),
});

// --- Writing one file, without a copy of the workspace (agents, scripts) ---
// Each is a change set of one operation underneath, with its merge and its conflicts. Without baseHash a write only
// creates; with it, it edits the version it names, merging text changed elsewhere meanwhile.

export const FileWriteBody = z.object({
  /** UTF-8 text; use contentBase64 for binary files and for any bytes a UTF-8 string wouldn't give back exactly (core: textContent) */
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  /** Hash of the version this edit started from (fontego cat --json); left out, only a new file is written */
  baseHash: z.string().nullable().optional(),
  mode: FileModeSchema.optional(),
  message: Text(10_000).optional(),
});

export const FileDeleteBody = z.object({ baseHash: z.string().optional(), message: Text(10_000).optional() });

export const FileMoveBody = z.object({ from: z.string(), to: z.string(), baseHash: z.string().optional(), message: Text(10_000).optional() });

export type PutOp = z.infer<typeof PutOpSchema>;
export type DeleteOp = z.infer<typeof DeleteOpSchema>;
export type MoveOp = z.infer<typeof MoveOpSchema>;
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
/** What a client sends */
export type ChangeSetRequest = z.input<typeof ChangeSetBody>;
/** What the server works with, once validated */
export type ChangeSet = z.output<typeof ChangeSetBody>;
