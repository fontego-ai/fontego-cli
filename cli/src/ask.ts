// The arguments a command was given without: a person at a terminal picks each from its list, or types it; anyone
// else (a script, an agent, --json) gets the usage line, with the values a list on this machine allows. After asking,
// the whole command goes to stderr, so it can be typed next time or handed to an agent.

import { UsageError, usageLine, type Parsed, type Usage, type UsageArg } from "./args.ts";
import { canAsk } from "./output.ts";
import { askText, choose, type Choice } from "./picker.ts";

/** Where one argument's values come from, or null when it is typed. */
export type ChoicesSource = { local: boolean; load: () => Promise<Choice[]> } | null;
export type SourceFor<A extends UsageArg> = (arg: A, args: Record<string, string>) => ChoicesSource;

export interface AskOptions<A extends UsageArg> {
  json: boolean;
  /** --instance, if given: it goes into the command written back */
  instance?: string;
  sourceFor: SourceFor<A>;
}

export async function askMissing<A extends UsageArg>(u: Usage & { args?: A[] }, parsed: Parsed, opts: AskOptions<A>): Promise<void> {
  const missing = ((u.args ?? []) as A[]).filter((a) => parsed.missing?.includes(a.name));
  if (!missing.length) return;
  if (!canAsk(opts.json)) throw new UsageError(await usageWithValues(u, missing, parsed, opts.sourceFor));
  for (const arg of missing) {
    const title = `${arg.name}${arg.description ? ` (${arg.description})` : ""}:`;
    const source = opts.sourceFor(arg, parsed.args);
    if (!source) {
      parsed.args[arg.name] = await askText(title.slice(0, -1));
      continue;
    }
    const choices = await source.load();
    if (!choices.length) throw new UsageError(`Nothing to pick for ${arg.name}: ${usageLine(u)}`);
    parsed.args[arg.name] = (await choose(title, choices)).value;
  }
  delete parsed.missing;
  process.stderr.write(`Same as: ${commandLine(u, parsed, opts.instance)}\n`);
}

/** The usage line, and for each argument left out whose values are known here, what it can be. */
async function usageWithValues<A extends UsageArg>(u: Usage, missing: A[], parsed: Parsed, sourceFor: SourceFor<A>): Promise<string> {
  const known: string[] = [];
  for (const arg of missing) {
    const source = sourceFor(arg, parsed.args);
    if (!source?.local) continue;
    const values = await source.load().catch(() => [] as Choice[]);
    if (values.length) known.push(`${arg.name}: ${values.map((c) => c.value).join(", ")}.`);
  }
  return [usageLine(u), ...known].join(" ");
}

const quote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The command as it could be typed: its words, its arguments and the flags given. Secrets and stdin never. */
export function commandLine(u: Usage, parsed: Parsed, instance?: string): string {
  const parts = ["fontego", ...u.name.split(" ")];
  for (const a of u.args ?? []) {
    const hidden = ("secret" in a && a.secret) || ("stdin" in a && a.stdin);
    const v = parsed.args[a.name];
    if (v === undefined || hidden) continue;
    parts.push(...(a.rest ? v.split(" ") : [v]).map(quote));
  }
  for (const f of u.flags ?? []) {
    const v = parsed.flags[f.name];
    if (v === undefined || v === false) continue;
    parts.push(v === true ? `--${f.name}` : `--${f.name} ${quote(String(v))}`);
  }
  if (instance) parts.push(`--instance ${quote(instance)}`);
  return parts.join(" ");
}
