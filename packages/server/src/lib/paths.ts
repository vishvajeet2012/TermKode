import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Sessions, provider keys, and the active model live here. Everything TermKode
// remembers is in this one directory, so it can be backed up or deleted as a
// unit.
const DIRECTORY_NAME = ".termkode";

export function getHomeDirectory() {
  const directory = process.env.TERMKODE_HOME ?? join(homedir(), DIRECTORY_NAME);
  mkdirSync(directory, { recursive: true });
  return directory;
}
