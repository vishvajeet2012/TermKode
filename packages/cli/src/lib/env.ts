import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getHomeDirectory } from "@termkode/server";

// TermKode uses the user's own provider keys, so it reads them from the same
// places a developer would expect: the shell environment, a project `.env`,
// and a personal `~/.termkode/.env` that works from any directory. Values
// already present in the environment always win.
function parseEnvFile(contents: string) {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).replace(/^export\s+/, "").trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (key) values[key] = value;
  }

  return values;
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  try {
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf-8")))) {
      process.env[key] ??= value;
    }
  } catch {
    // An unreadable .env file should never stop TermKode from starting.
  }
}

export function getTermkodeHome() {
  return getHomeDirectory();
}

export function loadEnvironment() {
  loadEnvFile(resolve(process.cwd(), ".env"));
  loadEnvFile(join(getTermkodeHome(), ".env"));
}
