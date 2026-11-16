// Types of the HTTP API (version 1). The server and every client use them.

export type Role = "reader" | "editor" | "admin";

export const ROLES: readonly Role[] = ["reader", "editor", "admin"];

/** reader < editor < admin */
export function roleAtLeast(role: Role | null | undefined, needed: Role): boolean {
  if (!role) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

/** Git file modes the API accepts. */
export type FileMode = "100644" | "100755" | "120000";

export interface ErrorBody {
  error: { code: string; message: string; hint?: string; details?: unknown };
}

export interface Me {
  user: { id: number; email: string; name: string; isAdmin: boolean };
  token: { id: number; label: string; kind: "person" | "agent" };
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

// --- Writing: a change set is a list of operations on whole files ---

export interface PutOp {
  op: "put";
  path: string;
  /** UTF-8 text; use contentBase64 for binary files */
  content?: string;
  contentBase64?: string;
  /** Git blob hash of the version this edit started from; null for a new file */
  baseHash: string | null;
  mode?: FileMode;
}

export interface DeleteOp {
  op: "delete";
  path: string;
  baseHash: string;
}

export interface MoveOp {
  op: "move";
  from: string;
  to: string;
  baseHash: string;
}

export type ChangeOp = PutOp | DeleteOp | MoveOp;

export interface ChangeSetRequest {
  /** The commit the client last synced; the base for three-way merges */
  baseCommit: string | null;
  message: string;
  ops: ChangeOp[];
  /** Free label of the client: "ws", "mcp", "web", "script"... */
  client?: string;
}

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
