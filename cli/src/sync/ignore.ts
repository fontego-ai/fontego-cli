// The ignore rules of a synced folder, read from its disk. The rules themselves live in core (core/src/ignore.ts),
// because the server applies them too when it imports a folder into a new workspace.

import { IgnoreRules } from "@fontego/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export { BUILT_IN, IGNORE_FILE, IgnoreRules, isJunk, MACHINE_IGNORE, STATE_DIR, type IgnoreMatch } from "@fontego/core";

/** The rules of the folder at `root`: built-in, its .fontego/ignore and its .fontegoignore files. */
export const loadIgnoreRules = (root: string): Promise<IgnoreRules> => IgnoreRules.load((path) => readFile(join(root, path), "utf8"));
