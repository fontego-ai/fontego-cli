// The ignore rules of a synced folder, read from its disk. The rules and their safe reading from a disk live in core
// (core/src/ignore.ts), because the server applies them too when it imports a folder into a new workspace.

import { IgnoreRules, rulesOnDisk } from "@fontego/core";

export { BUILT_IN, IGNORE_FILE, IgnoreRules, isJunk, MACHINE_IGNORE, STATE_DIR, type IgnoreMatch, type RulesProblem } from "@fontego/core";

/** The rules of the folder at `root`: built-in, its .fontego/ignore and its .fontegoignore files. */
export const loadIgnoreRules = (root: string): Promise<IgnoreRules> => IgnoreRules.load(rulesOnDisk(root));
