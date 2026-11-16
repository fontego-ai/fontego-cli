// Where the CLI keeps its login: $XDG_CONFIG_HOME/fontego/config.json (0600). FONTEGO_URL and FONTEGO_TOKEN override it,
// which is how an agent or a script uses fontego without touching the file.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  url: string;
  token: string;
}

export function configPath(env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "fontego", "config.json");
}

export function loadCliConfig(env = process.env): CliConfig | null {
  if (env.FONTEGO_URL && env.FONTEGO_TOKEN) return { url: env.FONTEGO_URL, token: env.FONTEGO_TOKEN };
  const path = configPath(env);
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
  const url = env.FONTEGO_URL || saved.url;
  const token = env.FONTEGO_TOKEN || saved.token;
  return url && token ? { url, token } : null;
}

export function saveCliConfig(cfg: CliConfig, env = process.env) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearCliConfig(env = process.env) {
  rmSync(configPath(env), { force: true });
}
