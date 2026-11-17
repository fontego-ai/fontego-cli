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
  /** Where the settings come from */
  source: string;
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
