// Types of the HTTP API (version 1): what the server answers. What requests carry is in schemas.ts.

import { ROLES, type Role } from "./schemas.ts";

/** reader < editor < admin */
export function roleAtLeast(role: Role | null | undefined, needed: Role): boolean {
  if (!role) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

export interface ErrorBody {
  error: { code: string; message: string; hint?: string; details?: unknown };
}

/** How a caller proved who it is: a session (a signed-in browser or CLI) or a token. */
export interface Credential {
  type: "session" | "token";
  id: number;
  /** web or cli for a session; person or agent for a token */
  kind: "web" | "cli" | "person" | "agent";
  /** The browser or the machine of a session; what a token is for */
  label: string;
  /** Sessions only: when it ends if nothing else happens (unused too long, or at its maximum) */
  expiresAt: string | null;
}

export interface Me {
  user: { id: number; email: string; name: string; isAdmin: boolean };
  credential: Credential;
}

/** How long sessions last on a server, decided by its admin. */
export interface SessionPolicies {
  web: { idleDays: number; maxDays: number };
  cli: { idleDays: number; maxDays: number };
}

/** What a server says about itself before anyone signs in (GET /v1/instance). */
export interface InstanceInfo {
  name: string;
  software: "fontego";
  version: string;
  sessions: SessionPolicies;
  oauth: {
    /** Where the CLI sends the browser (authorization code with PKCE) */
    authorizationEndpoint: string;
    tokenEndpoint: string;
    deviceAuthorizationEndpoint: string;
    /** The page where a device code is typed */
    verificationUri: string;
    revocationEndpoint: string;
    clientId: string;
  };
}

/** The answer of the token endpoint (RFC 6749 §5.1), plus when the session ends. */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  session: { id: number; expiresAt: string; email: string };
}

/** The answer of the device authorization endpoint (RFC 8628 §3.2). */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** active: can sign in; invited: has a link waiting to set a password; no-password: neither (a token-only account);
 * disabled: can't sign in, and its sessions and tokens were closed */
export type AccountStatus = "active" | "invited" | "no-password" | "disabled";

export interface UserSummary {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  disabled: boolean;
  status: AccountStatus;
  /** For server admins: when they last used the API */
  lastActiveAt?: string | null;
}

// --- For server admins ---

/** Someone, as admin lists show them */
export interface PersonRef {
  email: string;
  name: string;
}

export interface AdminSession {
  id: number;
  user: PersonRef;
  kind: "web" | "cli";
  /** The browser or the machine */
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AdminToken {
  id: number;
  user: PersonRef;
  kind: "person" | "agent";
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** One API call, from the access log */
export interface AccessEntry {
  at: string;
  user: string | null;
  /** How they signed in: "cli joel-laptop", "web Firefox on Linux", "token ci (agent)" */
  credential: string | null;
  agent: string | null;
  method: string;
  route: string;
  workspace: string | null;
  status: number;
}

/** One commit, from the change log: who wrote it, whatever its author says */
export interface ChangeEntry {
  at: string;
  workspace: string;
  commit: string;
  user: string | null;
  credential: string | null;
  agent: string | null;
  client: string;
  files: number;
}

/**
 * A path a workspace protects (only its admins change it) or rejects (nobody writes it: such files would run code on
 * the machines of everyone who syncs). Patterns are those of matchPath in paths.ts.
 */
export interface PathRule {
  kind: "protected" | "rejected";
  pattern: string;
  /** The workspace's own list, or the instance's default while the workspace has none of that kind */
  from: "workspace" | "instance";
}

export interface AdminWorkspace extends WorkspaceInfo {
  members: number;
}

export type LinkPurpose = "setup" | "invite" | "reset";

/** What a one-time link is for, so the page that opens it can say so. */
export interface LinkInfo {
  purpose: LinkPurpose;
  email: string;
  name: string;
  expiresAt: string;
  /** The server's visible name */
  instance: string;
}

/** What happened to a message: sent by mail, or held for an admin to pass on (no SMTP, or sending failed). */
export interface Delivery {
  status: "sent" | "held";
  /** Why it was held */
  reason?: string;
  /** Only when held, and only to a server admin: the link to pass on by hand */
  link?: string;
}

export interface InvitationResult {
  user: UserSummary;
  expiresAt: string;
  delivery: Delivery;
}

export interface MailStatus {
  transport: "smtp" | "none";
  host: string | null;
  port: number | null;
  from: string | null;
  /** Where the settings come from: the environment, the config file, the admin settings */
  source: string;
  /** Why there is no SMTP although part of it is set (a server without a sender) */
  problem?: string;
}

export type SettingValue = string | number | boolean | string[];

/**
 * One of the instance's settings. Each comes from the first of three places that has it: the server's own config
 * (environment or config file, which wins and can't be changed from the API), what an admin set from the web or the
 * CLI, or the default.
 */
export interface SettingEntry {
  key: string;
  group: "general" | "mail" | "sessions" | "workspaces";
  /** A list is of text, such as path patterns */
  type: "string" | "number" | "boolean" | "list";
  description: string;
  /** In effect now; null when unset, and always null for a secret */
  value: SettingValue | null;
  /** The value as text, for showing: "(set)" or "(not set)" for a secret, "-" when unset */
  display: string;
  default: SettingValue | null;
  /** Where the value comes from: env and file pin it */
  source: "default" | "admin" | "env" | "file";
  /** Set in the server's config, so it can only be changed there */
  pinned: boolean;
  /** When pinned: the environment variable, or the key in the config file */
  pinnedBy?: string;
  /** A secret (the SMTP password): it can be set, never read back */
  secret?: boolean;
  /** For a secret: whether it is set */
  isSet?: boolean;
  /** When an admin set it, and who */
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface OutboxMessage {
  id: number;
  createdAt: string;
  to: string;
  subject: string;
  kind: string;
  /** The link in it, if any: what an admin passes on when there is no mail */
  link: string | null;
  reason: string | null;
}

export interface WorkspaceInfo {
  slug: string;
  name: string;
  description: string;
  category: string;
  createdAt: string;
  head: string | null;
  role: Role | null;
  /** Date and author of the last change, if any */
  updatedAt: string | null;
  updatedBy: string | null;
  /** When a server admin archived it: hidden from lists and read-only until brought back */
  archivedAt?: string;
}

/** A file an import left out, and why: the same refusals as any write, or the ignore rules the source carries. */
export interface SkippedFile {
  /** A file, or a folder (ending in /) whose files the ignore rules kept out */
  path: string;
  /** ignored, path_rejected, secret_file, secret_content, file_too_large, invalid_path, submodule... */
  code: string;
  message: string;
  hint?: string;
  /** From a Git history: how many versions of it were left out */
  versions?: number;
}

/** What filled a new workspace. */
export interface WorkspaceImport {
  kind: "empty" | "template" | "folder" | "zip" | "git";
  /** What it came from, for people: "template demo", "zip notes.zip", "https://example.org/notes.git (main)" */
  source: string;
  /** Files in the workspace after the import */
  files: number;
  commits: number;
  head: string | null;
  /** From Git: whether its history came in, and whether commits had to be rewritten to leave files out */
  history?: boolean;
  rewritten?: boolean;
  skipped: SkippedFile[];
  /** For people: "14 files from the template demo, in 1 commit; 2 left out." */
  summary: string;
}

/** A new workspace, and what it was filled with. */
export interface CreatedWorkspace extends WorkspaceInfo {
  imported: WorkspaceImport;
}

/** A template new workspaces can start from: one that ships with the server, or the instance's own. */
export interface TemplateInfo {
  name: string;
  /** The first line of its README */
  description: string;
  from: "built-in" | "instance";
}

export interface Member {
  userId: number;
  email: string;
  name: string;
  role: Role;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  mode: string;
  hash: string;
  size: number | null;
}

export interface TreeResponse {
  rev: string | null;
  entries: TreeEntry[];
}

export interface FileMeta {
  path: string;
  hash: string;
  mode: string;
  size: number;
  rev: string;
  text: boolean;
}

export interface Commit {
  commit: string;
  parents: string[];
  author: { name: string; email: string };
  date: string;
  message: string;
  trailers: Record<string, string>;
}

export interface SyncChange {
  status: "put" | "delete";
  path: string;
  hash?: string;
  mode?: string;
}

export interface SyncResponse {
  head: string | null;
  since: string | null;
  /** true when "since" is unknown to the server and the client must treat "changes" as the full tree */
  reset: boolean;
  changes: SyncChange[];
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

// --- Writing ---

export interface Conflict {
  path: string;
  reason: "changed" | "exists" | "missing" | "binary" | "merge";
  currentHash: string | null;
  message: string;
}

export interface ChangeSetResult {
  status: "committed" | "unchanged";
  commit: string;
  parent: string | null;
  changes: Array<{ status: "put" | "delete"; path: string; hash?: string; merged?: boolean }>;
}

export interface CommitEvent {
  type: "commit";
  workspace: string;
  commit: string;
  parent: string | null;
  author: { name: string; email: string };
  client: string;
  changes: Array<{ status: "put" | "delete"; path: string }>;
  at: string;
}
