// The rules of a token's life that every side shows the same (Joel, 2026-11-21): it always ends, a year after it is
// made at the latest. No dependencies, so the web app takes them too.

/** A token lasts this many days at most */
export const TOKEN_MAX_DAYS = 365;
/** ...and this many when nobody says: what a session lasts at most by default, so nothing outlives it unasked */
export const TOKEN_DEFAULT_DAYS = 90;
/** How many workspaces a token can name; for more, all of them */
export const MAX_TOKEN_WORKSPACES = 50;
