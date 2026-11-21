// Types of the HTTP API (version 1): what the server answers. What requests carry is in schemas.ts.

import type { WorkspaceIcon } from "./icons.ts";
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

/**
 * Where someone's photo is, on this server: a path to GET with the same credential (`/v1/people/3/photo?v=…`, which
 * changes when the photo does, so it can be kept for good), or null when they have none or the caller may not see it.
 */
export type PhotoUrl = string | null;

export interface Me {
  user: { id: number; email: string; name: string; isAdmin: boolean; photoUrl: PhotoUrl };
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
  photoUrl: PhotoUrl;
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
  photoUrl: PhotoUrl;
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
  /** Date of the last change, if any */
  updatedAt: string | null;
  /** Who made the last change: their account's name of today, else the commit's author */
  updatedBy: string | null;
  /** The last change, with who made it (their agent too) */
  lastChange?: LastChange | null;
  /** When a server admin archived it: hidden from lists and read-only until brought back */
  archivedAt?: string;
  /** The icon its admins chose from core's list (icons.ts), or none */
  icon: WorkspaceIcon | null;
  /** Its tags, as they are kept (normalizeTag), in the order its admins gave them */
  tags: string[];
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
  /** What a workspace made from it starts with besides its files (its .fontego/template.toml): an icon, tags... */
  icon: WorkspaceIcon | null;
  tags: string[];
  /** ...and how many top-level folders it gives a line */
  folders: number;
  /** What is wrong with its .fontego/template.toml, when something is: nothing can be made from it until it's fixed */
  problem?: string;
}

/** The templates a new workspace can start from (GET /templates). */
export interface TemplatesResponse {
  templates: TemplateInfo[];
}

/** The icons a workspace can have here (GET /workspace-icons), in the order they are offered. */
export interface WorkspaceIconsResponse {
  icons: Array<{
    name: WorkspaceIcon;
    /** What it suits: "legal, contracts, compliance" */
    themes: string;
  }>;
}

/** The tags of the workspaces you see (GET /tags), by name, each with how many of those workspaces have it. */
export interface TagsResponse {
  tags: Array<{ name: string; workspaces: number }>;
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
  /** Null for a disabled account, whoever asks: what a workspace shows of its members is the same for all its readers */
  photoUrl: PhotoUrl;
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
  /**
   * With last=1: the newest commit that changed it (a folder: anything below it). Null when the server stopped reading
   * the history before reaching it (lastComplete is false then).
   */
  last?: LastChange | null;
}

export interface TreeResponse {
  rev: string | null;
  entries: TreeEntry[];
  /** With last=1: the newest change in the folder listed (at the top, in the whole workspace) */
  last?: LastChange | null;
  /**
   * With last=1: false when the server stopped reading the history before finding every entry's last change (a very
   * long history); those entries have last: null, and asking again goes on from where it stopped.
   */
  lastComplete?: boolean;
}

/**
 * The newest commit that changed a file or folder, on the line the workspace's head moved along (first parents): a
 * merge counts for what it brought.
 */
export interface LastChange {
  commit: string;
  date: string;
  /** The first line of its message */
  subject: string;
  author: { name: string; email: string };
  by: ChangeBy;
}

export interface FileMeta {
  path: string;
  hash: string;
  mode: string;
  size: number;
  rev: string;
  text: boolean;
}

/**
 * One change: a commit. GET /history and GET /activity answer with the same shape; `workspace` only in activity,
 * `files` and `filesTotal` only when asked for (files=1).
 */
export interface Commit {
  commit: string;
  parents: string[];
  author: { name: string; email: string };
  date: string;
  message: string;
  trailers: Record<string, string>;
  /** Who made it, resolved by the server */
  by?: ChangeBy;
  /** In activity: the workspace it is in (its id) */
  workspace?: string;
  /** What it changed, against its first parent (a merge: what it brought), the first FILES_PER_CHANGE of them */
  files?: CommitFile[];
  /** How many files it changed in all; more than files.length when the list was cut */
  filesTotal?: number;
}

/** At most this many files of one change come in an answer; filesTotal says how many there are. */
export const FILES_PER_CHANGE = 100;

/** A file a commit changed. Renames aren't followed: moving a file is deleting it and adding it, as in sync. */
export interface CommitFile {
  /** A change of type (a file becoming a link) is "modified" */
  status: "added" | "modified" | "deleted";
  path: string;
  /** Its new mode, unless it was deleted */
  mode?: string;
  /** The workspace rejects this path today, so sync leaves this change out of everyone's copies */
  rejected?: true;
}

/**
 * Who made a change, as the server resolves it. A commit the gate wrote is the person its change log names (checked
 * against the ids in the commit, so a commit brought in from elsewhere can't claim anyone); any other commit (an
 * imported history) is the account that has its author's email today.
 */
export interface ChangeBy {
  /**
   * The account, with its name, email and photo of today (no photo for a disabled account); null when none matches
   * (the author is all there is). A change by an agent still names its person: clients show the agent, not the photo.
   */
  user: { id: number; name: string; email: string; photoUrl: PhotoUrl } | null;
  /** The agent the client said it ran under (claude-code, codex...); only for changes written through the gate */
  agent: string | null;
  /** The client that sent it: fontego (the CLI), web, api... */
  client: string | null;
  /** How the writer had signed in, with the label it has today: a session ("cli", "joel-laptop") or a token */
  credential: { type: "session" | "token"; id: number; kind: Credential["kind"]; label: string } | null;
}

/** GET /history: commits, newest first. */
export interface HistoryResponse {
  commits: Commit[];
}

/** GET /activity: changes of every workspace someone can read, newest first, a page at a time. */
export interface ActivityResponse {
  /** Each with its workspace and who made it */
  commits: Commit[];
  /** Ask with cursor=next for the older ones; null when there are none */
  next: string | null;
  /**
   * Workspaces whose history the server is still reading (just upgraded, or catching up after a failure): their
   * changes may be missing from this answer for now. Absent when there are none.
   */
  indexing?: string[];
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

// --- Live: the event streams and who is in each workspace now ---

/** A new commit in a workspace (GET /workspaces/{ws}/events, and GET /events for every workspace someone reads). */
export interface CommitEvent {
  type: "commit";
  workspace: string;
  commit: string;
  parent: string | null;
  author: { name: string; email: string };
  client: string;
  /** The agent the writer's client said it runs under ("claude-code"), or null for the person themself */
  agent: string | null;
  /** The first line of the commit's message */
  message: string;
  changes: Array<{ status: "put" | "delete"; path: string }>;
  at: string;
}

/** What someone is doing in a workspace: reading it, editing a file in the web, or working in it (writing). */
export type PresenceActivity = "reading" | "editing" | "working";

/** Someone in a workspace now: a person, or one of their agents (each shows once, with what it does most). */
export interface PresenceEntry {
  workspace: string;
  /** The account, as it is today (its name may have changed since it last wrote). An agent's entry names its person too */
  user: { id: number; name: string; email: string; photoUrl: PhotoUrl };
  /** The agent ("claude-code"), or null for the person themself */
  agent: string | null;
  activity: PresenceActivity;
  /** The file or folder (a folder ends in /), or null for the whole workspace */
  path: string | null;
  /** Where it comes from: a tab of the web app, the CLI, or another client of the API */
  via: "web" | "cli" | "api";
  /** For people: "working in clients/harbor-cafe/", "reading in the web", "editing notes.md in the web" */
  doing: string;
  since: string;
  /** When it fades if nothing renews it */
  until: string;
}

/** Who is around: in every workspace someone reads, or in one (GET /presence). */
export interface PresenceResponse {
  here: PresenceEntry[];
}

/** After announcing yourself in a workspace: your entry there, and everyone in it now. */
export interface PresenceAnnouncement {
  workspace: string;
  you: PresenceEntry;
  here: PresenceEntry[];
}

/** After clearing your announcement: who is still there. */
export interface PresenceCleared {
  workspace: string;
  here: PresenceEntry[];
}

/** First event of GET /events, on every (re)connection: compare what you show, here is everyone around. */
export interface ReadyEvent {
  type: "ready";
  /** How often the server sends something; a client that hears nothing for two of these can take the line as dead */
  heartbeat: number;
  presence: PresenceEntry[];
}

/** Who is in a workspace now, whole, each time it changes */
export interface PresenceEvent {
  type: "presence";
  workspace: string;
  here: PresenceEntry[];
}

/**
 * The workspaces someone sees, or what GET /workspaces says of one, changed (added to one, removed, a new role,
 * renamed, archived, deleted): read the list again.
 */
export interface WorkspacesEvent {
  type: "workspaces";
  workspace: string | null;
}

/** What GET /events sends after ready */
export type LiveEvent = CommitEvent | PresenceEvent | WorkspacesEvent;

/**
 * The last event of a stream the server closes on purpose: this person opened more streams than they may keep, and
 * this one is the oldest. Connecting again at once would close another one: wait, or close the others.
 */
export interface ClosedEvent {
  type: "closed";
  reason: "too_many_streams";
  message: string;
}
