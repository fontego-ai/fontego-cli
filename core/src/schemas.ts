// What every request of the API (version 1) may carry. The server validates each request against these schemas, and
// the request types clients use come from them, so a client and the server can't disagree on what a request is.

import { z } from "zod";

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
const Text = (max: number) => z.string().max(max);

// --- Workspaces and members ---

export const CreateWorkspaceBody = z.object({
  slug: Slug,
  name: Text(200).optional(),
  description: Text(5000).optional(),
  category: Text(100).optional(),
});
export type CreateWorkspaceRequest = z.input<typeof CreateWorkspaceBody>;

export const UpdateWorkspaceBody = z.object({
  name: Text(200).optional(),
  description: Text(5000).optional(),
  category: Text(100).optional(),
});
export type UpdateWorkspaceRequest = z.input<typeof UpdateWorkspaceBody>;

export const SetMemberBody = z.object({ role: RoleSchema });

// --- People, passwords and tokens ---

/** NIST SP 800-63B: at least 15 characters when a password is the only thing that proves who you are. */
export const MIN_PASSWORD = 15;
export const MAX_PASSWORD = 256;
const NewPassword = z
  .string()
  .min(MIN_PASSWORD, `use at least ${MIN_PASSWORD} characters (a few words make a good one)`)
  .max(MAX_PASSWORD, `use at most ${MAX_PASSWORD} characters`);

export const CreateUserBody = z.object({
  email: Email,
  name: Text(200).optional(),
  isAdmin: z.boolean().optional(),
});

export const CreateTokenBody = z.object({
  label: Text(200).optional(),
  kind: z.enum(["person", "agent"]).optional(),
});

/** Invites someone: creates their account, without a password, and sends them a one-time link to set one. */
export const InviteBody = z.object({
  email: Email,
  name: Text(200).optional(),
  admin: z.boolean().optional(),
});

/** Uses a one-time link (set up the first admin, accept an invitation, reset a password): the new password. */
export const UseLinkBody = z.object({ password: NewPassword, name: Text(200).optional() });

/** Asks for a link to set a new password. The answer is the same whether the address has an account or not. */
export const PasswordResetBody = z.object({ email: Email });

export const MailTestBody = z.object({ to: Email });

// --- OAuth, for the CLI to sign in through the browser. Field names are the standard's (RFC 6749, 7636, 8628). ---

/** The person's answer, from a signed-in browser, to "connect the CLI of <machine>?" */
export const AuthorizeBody = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.string(),
  state: z.string().max(500).optional(),
  machine: Text(80).optional(),
  approve: z.boolean(),
});

export const DeviceStartBody = z.object({ client_id: z.string(), machine: Text(80).optional() });

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

export const WorkspacesQuery = z.object({ category: Opt });
export const TreeQuery = z.object({ path: Opt, rev: Opt, recursive: Flag });
export const FileQuery = z.object({ rev: Opt, meta: Flag, download: Flag });
export const HistoryQuery = z.object({ path: Opt, rev: Opt, limit: Opt });
export const SyncQuery = z.object({ since: Opt });
export const SearchQuery = z.object({ q: z.string(), path: Opt, limit: Opt });

// --- For server admins ---

/** A destructive action says yes on purpose. */
export const ConfirmBody = z.object({ confirm: z.literal(true, "add --yes: this can't be undone") });

/** Lists for admins, maybe of one person */
export const ByUserQuery = z.object({ user: Opt });

export const AuditQuery = z.object({ user: Opt, workspace: Opt, since: Opt, limit: Opt });

// --- Writing: a change set is a list of operations on whole files ---

export const MAX_OPS = 1000;

export const PutOpSchema = z.object({
  op: z.literal("put"),
  path: z.string(),
  /** UTF-8 text; use contentBase64 for binary files */
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
  client: Text(40).optional(),
});

export type PutOp = z.infer<typeof PutOpSchema>;
export type DeleteOp = z.infer<typeof DeleteOpSchema>;
export type MoveOp = z.infer<typeof MoveOpSchema>;
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
/** What a client sends */
export type ChangeSetRequest = z.input<typeof ChangeSetBody>;
/** What the server works with, once validated */
export type ChangeSet = z.output<typeof ChangeSetBody>;
