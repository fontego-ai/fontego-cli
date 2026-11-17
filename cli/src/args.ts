// Reading the command line. A command is one or more words (`members set`), then its arguments and flags; which flags
// take a value depends on the command, so the words are resolved first and the rest is read with that command's
// flags. --json, --help, -h and --instance ALIAS work anywhere.

export class UsageError extends Error {}

export interface UsageArg {
  name: string;
  optional?: boolean;
  /** The last argument may take every remaining word */
  rest?: boolean;
  description?: string;
}

export interface UsageFlag {
  name: string;
  short?: string;
  type: "string" | "number" | "boolean";
  value?: string;
  default?: string | number | boolean;
  description: string;
}

/** What help needs to know about a command, built-in or declared by the server. */
export interface Usage {
  name: string;
  aliases?: string[];
  summary: string;
  group: string;
  admin?: boolean;
  args?: UsageArg[];
  flags?: UsageFlag[];
}

export interface Globals {
  json: boolean;
  help: boolean;
  /** --instance ALIAS: which Fontego this command goes to */
  instance?: string;
  /** Everything else, in order */
  tokens: string[];
}

export function readGlobals(argv: string[]): Globals {
  const tokens: string[] = [];
  let json = false;
  let help = false;
  let instance: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      tokens.push(...argv.slice(i));
      break;
    }
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--instance") {
      instance = argv[++i];
      if (!instance) throw new UsageError("--instance needs an alias: --instance ALIAS");
    } else if (a.startsWith("--instance=")) instance = a.slice("--instance=".length);
    else tokens.push(a);
  }
  return { json, help, instance, tokens };
}

/** The words before the first flag: the command and, after it, its first arguments. */
export function leadingWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) break;
    out.push(t);
  }
  return out;
}

/** The longest command name (up to three words) that the leading words start with. */
export function resolveName(words: string[], names: Iterable<string>): string | null {
  const known = new Set(names);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const candidate = words.slice(0, n).join(" ");
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export const usageLine = (u: Usage): string =>
  [
    `fontego ${u.name}`,
    ...(u.args ?? []).map((a) => {
      const name = a.rest ? `${a.name}...` : a.name;
      return a.optional ? `[${name}]` : name;
    }),
    ...(u.flags ?? []).map((f) => {
      const flag = f.short ? `-${f.short}` : `--${f.name}`;
      return f.type === "boolean" ? `[${flag}]` : `[--${f.name} ${f.value ?? f.name.toUpperCase()}]`;
    }),
  ].join(" ");

export interface Parsed {
  /** Positional values by argument name */
  args: Record<string, string>;
  /** Flag values by flag name; only flags that were given */
  flags: Record<string, string | number | boolean>;
}

/** Reads what follows the command's words, with the command's own flags. */
export function parseCommand(u: Usage, tokens: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean> = {};
  const byName = new Map((u.flags ?? []).map((f) => [f.name, f]));
  const byShort = new Map((u.flags ?? []).filter((f) => f.short).map((f) => [f.short!, f]));
  const known = () => ((u.flags ?? []).length ? ` Options: ${(u.flags ?? []).map((f) => `--${f.name}`).join(", ")}.` : "");

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      positional.push(t);
      continue;
    }
    const long = t.startsWith("--");
    const [key, inline] = long ? (t.slice(2).split(/=(.*)/s) as [string, string | undefined]) : [t.slice(1), undefined];
    const flag = long ? byName.get(key) : byShort.get(key);
    if (!flag) throw new UsageError(`fontego ${u.name} has no option ${t}.${known()}`);
    if (flag.type === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${flag.name} takes no value.`);
      flags[flag.name] = true;
      continue;
    }
    const value = inline ?? tokens[++i];
    if (value === undefined) throw new UsageError(`--${flag.name} needs a value: ${usageLine(u)}`);
    if (flag.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UsageError(`--${flag.name} needs a number, not "${value}".`);
      flags[flag.name] = n;
    } else flags[flag.name] = value;
  }

  const specs = u.args ?? [];
  if (specs.at(-1)?.rest && positional.length > specs.length) positional.splice(specs.length - 1, Infinity, positional.slice(specs.length - 1).join(" "));
  if (positional.length > specs.length) throw new UsageError(`Too many arguments: ${usageLine(u)}`);
  const args: Record<string, string> = {};
  specs.forEach((a, i) => {
    const v = positional[i];
    if (v === undefined) {
      if (!a.optional) throw new UsageError(usageLine(u));
    } else args[a.name] = v;
  });
  return { args, flags };
}
