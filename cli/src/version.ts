// The CLI's version, from its package.json: the one place it is written. It also goes into the executables
// (scripts/build.ts) and the npm packages, so `fontego version` always says what was installed.

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const USER_AGENT = `fontego-cli/${VERSION}`;
