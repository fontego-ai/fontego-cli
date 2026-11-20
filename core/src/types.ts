// Types of the HTTP API (version 1): what the server answers. What requests carry is in schemas.ts.

import type { PreferenceKey, Preferences } from "./preferences.ts";
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

/** A signed-in browser or CLI. */
export interface SessionInfo {
  id: number;
  kind: "web" | "cli";
  /** The browser or the machine */
  label: string;
  createdAt: string;
  lastUsedAt: string;
  /** When it ends if nothing else happens: unused too long, or at its maximum */
  expiresAt: string;
  /** The session the request that listed it came with */
  current: boolean;
}

/** Your own open sessions (GET /me/sessions), newest first. */
export interface MySessionsResponse {
  sessions: SessionInfo[];
}

/** A session closed by its owner (DELETE /me/sessions/{id}); when it was the one in use, that was signing out. */
export interface ClosedSession {
  closed: number;
  current: boolean;
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
  /** When they last used the API, to the minute; null if never. Only server admins get a UserSummary */
  lastActiveAt: string | null;
}

/** A workspace someone is in, as another person may see it. */
export interface PersonWorkspace {
  slug: string;
  name: string;
  /** Their role in it */
  role: Role;
  /** Only server admins see archived ones: when it was archived */
  archivedAt?: string;
}

/**
 * Someone with an account, as the people who use this Fontego see each other (GET /people). Anyone signed in sees
 * every account that isn't disabled; a server admin sees them all, with their status and last activity.
 */
export interface Person {
  id: number;
  email: string;
  name: string;
  /** A server admin of this Fontego */
  isAdmin: boolean;
  /**
   * The workspaces they are in that the caller sees: the ones both are in, not archived; for a server admin, all of
   * theirs, archived ones too
   */
  workspaces: PersonWorkspace[];
  /** Server admins only */
  status?: AccountStatus;
  /** Server admins only: when they last used the API, to the minute; null if never */
  lastActiveAt?: string | null;
}

export interface PeopleResponse {
  people: Person[];
}

/** One person's page (GET /people/{person}). */
export interface PersonDetail extends Person {
  /** Server admins only: where they are signed in, newest first */
  sessions?: SessionInfo[];
}

/** What changed when a server admin edited someone's account (PATCH /admin/users/{person}). */
export interface AccountEdit {
  user: UserSummary;
  /** When the email changed (not just its capitals): what was sent where */
  emailChange?: EmailChange;
}

/**
 * Someone's email changed. Every one-time link sent to the old address stopped working; sessions and tokens stay
 * open, since the person is the same.
 */
export interface EmailChange {
  previous: string;
  /** The notice to the old address */
  previousNotice: Delivery;
  /**
   * What went to the new address: a notice; or, when an invitation was waiting, a new invitation in its place, with
   * its link while the mail is held
   */
  newAddress: { kind: "notice" | "invitation"; delivery: Delivery; expiresAt?: string };
}

// --- For server admins ---

/** Someone, as admin lists show them */
export interface PersonRef {
  email: string;
  name: string;
}

/** Someone's session, in the lists of server admins */
export interface AdminSession extends SessionInfo {
  user: PersonRef;
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

/**
 * A top-level folder of a workspace and the line its admins wrote to say what goes in it. A description stays when its
 * folder goes (deleted, or moved under another name), marked as not there, until an admin takes it away; if the folder
 * comes back, so does its line.
 */
export interface FolderInfo {
  /** The folder's name: only top-level folders take a description */
  path: string;
  /** What goes in it; null when nobody has said */
  description: string | null;
  /** Whether the folder is in the workspace now (at its head); false: its description waits to be taken away */
  exists: boolean;
  /** With a description: when it was last set, and by whom (their name, or their email) */
  updatedAt?: string;
  updatedBy?: string | null;
}

/** The top-level folders of a workspace with their descriptions, then the descriptions whose folder is gone. */
export interface FoldersResponse {
  folders: FolderInfo[];
}

/** One workspace (GET /workspaces/{workspace}): what lists show, plus its top-level folders. */
export interface WorkspaceDetails extends WorkspaceInfo {
  folders: FolderInfo[];
}

/** The workspaces someone can see, with their role in each (GET /workspaces). */
export interface WorkspacesResponse {
  workspaces: WorkspaceInfo[];
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

/**
 * The categories of a Fontego (GET /categories). With `fixed`, its admins chose the list, and a workspace's category is
 * one of these or none; otherwise a category is any text, and these are the ones in use.
 */
export interface CategoriesResponse {
  fixed: boolean;
  categories: Array<{
    name: string;
    /** How many of the workspaces you see have it */
    workspaces: number;
  }>;
}

/** One of your preferences, with the type of its key. */
export type PreferenceEntry = {
  [K in PreferenceKey]: {
    key: K;
    /** In effect now: what you set, or the default */
    value: Preferences[K];
    default: Preferences[K];
    /** Whether you set it; false while the default applies */
    set: boolean;
    description: string;
    /** The value as text, for showing: "notes, handbook", "(none)" */
    display: string;
    /** When you last set it */
    updatedAt: string | null;
  };
}[PreferenceKey];

export interface PreferencesResponse {
  preferences: PreferenceEntry[];
}

/** Someone in a workspace. Anyone who reads the workspace sees whether they can sign in and when they last came. */
export interface Member {
  userId: number;
  email: string;
  name: string;
  role: Role;
  status: AccountStatus;
  /** When they last used the API, to the minute; null if never */
  lastActiveAt: string | null;
}

/** Who is in a workspace (GET /workspaces/{ws}/members, and what changing a member answers). */
export interface MembersResponse {
  members: Member[];
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  mode: string;
  hash: string;
  size: number | null;
  /** A top-level folder's description, when it has one */
  description?: string;
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
