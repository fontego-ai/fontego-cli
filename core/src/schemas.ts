// What every request of the API (version 1) may carry. The server validates each request against these schemas, and
// the request types clients use come from them, so a client and the server can't disagree on what a request is.

import { z } from "zod";
import { normalizeTags } from "./tags.ts";
import { MAX_TOKEN_WORKSPACES, TOKEN_MAX_DAYS } from "./tokens.ts";
import { MAX_SESSION_NAME } from "./sessions.ts";

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

/**
 * Workspace ids, as a JSON list or as text with commas (what the CLI sends: --workspaces a,b). Spaces around each
 * are dropped and a repeated one counts once.
 */
const SlugList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => [...new Set((typeof v === "string" ? v.split(",") : v).map((s) => s.trim()).filter(Boolean))])
  .pipe(z.array(Slug).min(1).max(MAX_TOKEN_WORKSPACES, `name at most ${MAX_TOKEN_WORKSPACES} workspaces, or all of them (--all)`));

/**
 * What a credential with a scope reaches and how long it lasts, as its person gives it: a token they make, or an app
 * they connect through OAuth. Which workspaces (some, by id, or `all` of the person's, now and later: one or the
 * other, so a workspace named "all" is never every one), whether it also writes (by default it only reads), and how
 * many days it lasts.
 */
const ScopeFields = {
  workspaces: SlugList.optional(),
  all: z.literal(true, "is true for every workspace, or left out").optional(),
  access: z.enum(["read", "write"]).optional(),
  expiresInDays: z
    .number()
    .int("use whole days")
    .min(1, "at least one day")
    .max(TOKEN_MAX_DAYS, `at most ${TOKEN_MAX_DAYS} days: it always ends, a year after it is given at the latest`)
    .optional(),
};

/** A scope names some workspaces or all of them: one of the two, never both. */
const scopeRules = <T extends z.ZodType<{ workspaces?: string[]; all?: true }>>(schema: T) =>
  schema
    .refine((b) => b.workspaces !== undefined || b.all === true, {
      message: "say which workspaces it reaches: some (--workspaces A,B) or all of yours (--all)",
      path: ["workspaces"],
    })
    .refine((b) => !(b.workspaces !== undefined && b.all === true), { message: "either some workspaces (--workspaces) or all of them (--all), not both", path: ["all"] });

/** A new token, for CI and scripts: a name to know it by, and its scope (ScopeFields). */
export const CreateTokenBody = scopeRules(
  z.object({
    name: z
      .string()
      .trim()
      .min(1, "give it a name, to know it in the list")
      .max(100, "use at most 100 characters")
      .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "must be one line, without control characters"),
    ...ScopeFields,
  }),
);
export type CreateTokenRequest = z.input<typeof CreateTokenBody>;

/** What a person gives an app that asks to connect through OAuth (oauth/apps.ts): its scope, as a token's. */
export const AppGrantBody = scopeRules(z.object(ScopeFields));
export type AppGrantRequest = z.input<typeof AppGrantBody>;

/** A person's name, as others see it beside what they change: never empty once it is changed. */
const PersonName = z
  .string()
  .trim()
  .min(1, "can't be empty")
  .max(200, "use at most 200 characters")
  .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "must be one line, without control characters");

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

// --- Your sessions ---

/** The name of a session: one line, never empty, as it is given at sign-in (fontego login --name) or later. */
export const SessionName = z
  .string()
  .trim()
  .min(1, "can't be empty")
  .max(MAX_SESSION_NAME, `use at most ${MAX_SESSION_NAME} characters`)
  .refine((s) => !CONTROL_TEXT.test(s) && !/[\t\r\n]/.test(s), "must be one line, without control characters");

/** Another name for one of your sessions (PATCH /me/sessions/{id}), so two machines named alike can be told apart. */
export const RenameSessionBody = z.object({ label: SessionName });
export type RenameSessionRequest = z.input<typeof RenameSessionBody>;

// --- OAuth: the CLI signs in through the browser, and apps (MCP clients such as claude.ai) ask a person to connect.
// Field names are the standard's (RFC 6749, 7636, 8628, 8707). ---

/** A client's `state`, given back as it came; long enough for what real clients send */
export const MAX_OAUTH_STATE = 2000;

/**
 * An authorization request, as a client sends the browser to /oauth/authorize. Everything but the client and where to
 * go back is optional here: what else is missing or wrong is told to the client, back where it asked to go, once
 * that place is known to be its own.
 */
const AuthorizationFields = {
  client_id: z.string().max(2000),
  redirect_uri: z.string().max(2000),
  response_type: z.string().max(100).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(MAX_OAUTH_STATE).optional(),
  scope: z.string().max(1000).optional(),
  resource: z.string().max(2000).optional(),
};

/** GET /oauth/authorize: what the page asks before showing it to the person (oauth/operations.ts). */
export const AuthorizeQuery = z.object(AuthorizationFields);

/**
 * The person's answer, from a signed-in browser: to "connect the CLI of <machine>?", or to an app asking to connect,
 * with what they give it. Those fields are checked as AppGrantBody only when it is an app they approve, so a refusal
 * always goes back, and a wrong choice says so in the page's own words.
 */
export const AuthorizeBody = z.object({
  ...AuthorizationFields,
  machine: Line(80).optional(),
  approve: z.boolean(),
  workspaces: z.unknown().optional(),
  all: z.unknown().optional(),
  access: z.unknown().optional(),
  expiresInDays: z.unknown().optional(),
});

export const DeviceStartBody = z.object({ client_id: z.string(), machine: Line(80).optional() });

export const DeviceDecisionBody = z.object({ approve: z.boolean() });

/**
 * The token endpoint, as a form or JSON. `resource` (RFC 8707) is what an app's tokens are for: this server's MCP.
 * `scope`, on a refresh, may name what the app was given or less, never more (RFC 6749 §6).
 */
export const TokenBody = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().max(500),
    code_verifier: z.string().max(200),
    redirect_uri: z.string().max(2000),
    client_id: z.string().max(2000),
    resource: z.string().max(2000).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(500),
    client_id: z.string().max(2000).optional(),
    resource: z.string().max(2000).optional(),
    scope: z.string().max(1000).optional(),
  }),
  z.object({ grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"), device_code: z.string().max(500), client_id: z.string().max(2000) }),
]);

/** Closes what a token proves (RFC 7009); an app, a public client, says who it is with its client_id. */
export const RevokeBody = z.object({ token: z.string().max(500), token_type_hint: z.string().max(100).optional(), client_id: z.string().max(2000).optional() });

/**
 * Opens a browser session: with email and password, or a one-time code from `fontego open`. Never with a token: a
 * token reaches only some workspaces, and a browser session would reach everything its person does.
 */
export const SessionBody = z.union([z.object({ email: z.string(), password: z.string().max(MAX_PASSWORD) }), z.object({ code: z.string() })]);

// --- Reading ---

/** Query values arrive as text; a flag is on with "1" or "true". */
const Flag = z.string().optional();
const Opt = z.string().optional();

/** tag: the workspaces with every one of these tags (split by commas), written as they are kept or not */
export const WorkspacesQuery = z.object({ category: Opt, tag: TagList.optional() });
/** last=1: each entry's last change (TreeEntry.last) */
export const TreeQuery = z.object({ path: Opt, rev: Opt, recursive: Flag, last: Flag });
/** Some lines of a text file, counted from 1: "120-200", "120-" (to the end) or "120" (that one) */
export const LineRange = z.string().regex(/^[1-9][0-9]{0,9}(-([1-9][0-9]{0,9})?)?$/, "lines go like 120-200, 120- (to the end) or 120");
/** lines: only those lines of a text file (the answer says which in x-lines, and how many it has in x-total-lines) */
export const FileQuery = z.object({ rev: Opt, meta: Flag, download: Flag, lines: LineRange.optional() });
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

// --- Editing one file by pieces: an exact text becomes another, without sending the whole file ---

/** The most edits one call makes to a file; they are applied in order, each on what the one before left. */
export const MAX_EDITS = 100;

/** The most a file of edits read by the CLI (`fontego edit --edits FILE`) may hold. */
export const EDITS_MAX_BYTES = 32 * 1024 * 1024;

const OldText = z.string().min(1, "can't be empty: say which text to change");

export const FileEditSchema = z.object({
  /** The exact text that is there now: once, or at least once with `all` */
  old: OldText,
  /** What it becomes; "" deletes it */
  new: z.string(),
  /** Every place the old text appears, instead of exactly one */
  all: z.boolean().optional(),
});

/**
 * One edit (`old`, `new`, `all`) or several (`edits`), never both; the server says which is missing, in the words of
 * the command. Without baseHash they apply to the latest version; with it, to that version, merged with what changed
 * since, as a write with baseHash.
 */
export const FileEditBody = z.object({
  old: OldText.optional(),
  new: z.string().optional(),
  all: z.boolean().optional(),
  edits: z
    // A string is what a fontego older than this command sends for --edits FILE: the file's bytes in base64
    .array(FileEditSchema, { error: (issue) => (typeof issue.input === "string" ? "must be a list of edits, not a string (a fontego older than edit sends --edits so: update it, npm i -g fontego, or use --old and --new)" : undefined) })
    .min(1, "send at least one edit")
    .max(MAX_EDITS, `split them: at most ${MAX_EDITS} edits in one call`)
    .optional(),
  /** Hash of the version the edits were made on (fontego cat --json); left out, the latest one */
  baseHash: z.string().optional(),
  message: Text(10_000).optional(),
});

export type PutOp = z.infer<typeof PutOpSchema>;
export type DeleteOp = z.infer<typeof DeleteOpSchema>;
export type MoveOp = z.infer<typeof MoveOpSchema>;
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
export type FileEdit = z.infer<typeof FileEditSchema>;
/** What a client sends to edit a file by pieces */
export type FileEditRequest = z.input<typeof FileEditBody>;
/** What a client sends */
export type ChangeSetRequest = z.input<typeof ChangeSetBody>;
/** What the server works with, once validated */
export type ChangeSet = z.output<typeof ChangeSetBody>;
