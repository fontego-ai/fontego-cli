// What a session's name may be, with no dependencies, so the web app takes it too (its schema, SessionName, is in
// schemas.ts). A session is a signed-in browser or a machine with the CLI; its name is what Your account lists.

/** The longest name a session takes */
export const MAX_SESSION_NAME = 80;

/** The fontego CLI's client id at every Fontego's OAuth server: a public client, built in, that gets a session */
export const CLI_CLIENT_ID = "fontego-cli";
