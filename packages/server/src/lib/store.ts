import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHomeDirectory } from "./paths";

// TermKode keeps everything on the machine that runs it. Sessions live in plain
// JSON files so the CLI works offline, needs no database, and stays fully
// inspectable by the person using it.
export type StoredSession = {
  id: string;
  title: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
};

export type SessionSummary = Pick<StoredSession, "id" | "title" | "createdAt">;

function getSessionsDirectory() {
  const directory = join(getHomeDirectory(), "sessions");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function getSessionPath(id: string) {
  return join(getSessionsDirectory(), `${sanitizeId(id)}.json`);
}

// Session ids come from the client, so never let one escape the sessions
// directory through path separators or parent references.
function sanitizeId(id: string) {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "");
  if (!sanitized) {
    throw new Error("Invalid session id");
  }

  return sanitized;
}

function parseSession(contents: string): StoredSession | null {
  try {
    const parsed = JSON.parse(contents) as Partial<StoredSession>;

    if (typeof parsed.id !== "string" || typeof parsed.title !== "string") {
      return null;
    }

    return {
      id: parsed.id,
      title: parsed.title,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
      createdAt: parsed.createdAt ?? new Date(0).toISOString(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? new Date(0).toISOString(),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return null;
  }
}

// Write to a temporary file first so an interrupted write can never leave a
// half-serialized session behind.
function writeSession(session: StoredSession) {
  const path = getSessionPath(session.id);
  const temporaryPath = `${path}.tmp`;

  writeFileSync(temporaryPath, JSON.stringify(session, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function listSessions(): SessionSummary[] {
  const directory = getSessionsDirectory();
  const sessions: StoredSession[] = [];

  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;

    try {
      const session = parseSession(readFileSync(join(directory, entry), "utf-8"));
      if (session) sessions.push(session);
    } catch {
      // Skip unreadable or partially written session files.
    }
  }

  return sessions
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ id, title, createdAt }) => ({ id, title, createdAt }));
}

export function getSession(id: string): StoredSession | null {
  try {
    return parseSession(readFileSync(getSessionPath(id), "utf-8"));
  } catch {
    return null;
  }
}

export function createSession({
  title,
  cwd,
}: {
  title: string;
  cwd: string;
}): StoredSession {
  const now = new Date().toISOString();
  const session: StoredSession = {
    id: randomUUID(),
    title,
    cwd,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  writeSession(session);
  return session;
}

export function saveSessionMessages(id: string, messages: unknown[]): StoredSession | null {
  const session = getSession(id);
  if (!session) return null;

  const updated: StoredSession = {
    ...session,
    messages,
    updatedAt: new Date().toISOString(),
  };

  writeSession(updated);
  return updated;
}
