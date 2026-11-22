import type { Parsed, Usage } from "../args.ts";
import type { Connection } from "../connect.ts";

export interface RunContext {
  parsed: Parsed;
  json: boolean;
  /** --instance, if given */
  instance?: string;
  print: (data: unknown, text: () => string) => void;
  /** Signs in to the instance this command is for (connect.ts). A synced folder's commands pass its URL. */
  connect: (opts?: { folderUrl?: string }) => Promise<Connection>;
}

export interface Builtin extends Usage {
  run(rc: RunContext): Promise<void>;
}
