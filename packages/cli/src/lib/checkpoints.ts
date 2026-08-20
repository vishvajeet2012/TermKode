import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describeToolCall, isWriteTool } from "@termkode/shared";
import { getTermkodeHome } from "./env";

// An agent that edits files without a way back is a gamble. Before every write
// TermKode copies the files that call is about to change, so `/rewind` can put
// them back exactly as they were - including files the call created, which are
// removed again on restore.
//
// Snapshots are per file rather than a git stash on purpose: they work in a
// project that is not a repository, and they never touch the user's index,
// stash list, or history.

const CHECKPOINTS_DIRECTORY = "checkpoints";
/** Beyond this a file is recorded as skipped rather than copied. */
const MAX_SNAPSHOT_BYTES = 2_000_000;
/** Older checkpoints are pruned so a long session cannot fill the disk. */
const MAX_CHECKPOINTS_PER_SESSION = 60;

export type CheckpointFile = {
  /** Project-relative path, as the user sees it. */
  path: string;
  /** Absolute path, so a restore does not depend on the working directory. */
  absolutePath: string;
  existed: boolean;
  /** Absent when the file did not exist, or was too large to copy. */
  content?: string;
  skipped?: boolean;
};

export type Checkpoint = {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  /** What the agent was about to do, e.g. "editFile src/app.ts". */
  label: string;
  toolName: string;
  files: CheckpointFile[];
};

export type CheckpointSummary = Pick<
  Checkpoint,
  "id" | "createdAt" | "label" | "toolName"
> & {
  files: string[];
};

function getSessionDirectory(sessionId: string) {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) throw new Error("Invalid session id");

  return join(getTermkodeHome(), CHECKPOINTS_DIRECTORY, safeId);
}

/** Which files a tool call is about to change, before it changes them. */
export function collectTargetPaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];

  const record = input as Record<string, unknown>;

  if (toolName === "writeFile" || toolName === "editFile") {
    return typeof record.path === "string" ? [record.path] : [];
  }

  if (toolName === "multiEdit" && Array.isArray(record.edits)) {
    return [
      ...new Set(
        record.edits
          .map((edit) =>
            edit && typeof edit === "object" ? (edit as { path?: unknown }).path : null,
          )
          .filter((value): value is string => typeof value === "string"),
      ),
    ];
  }

  return [];
}

function snapshotFile(cwd: string, path: string): CheckpointFile | null {
  const absolutePath = resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);

  // A checkpoint that could restore outside the project would be a way around
  // the tool sandbox, so those are never recorded.
  if (relativePath.startsWith("..")) return null;

  if (!existsSync(absolutePath)) {
    return { path: relativePath, absolutePath, existed: false };
  }

  try {
    const info = statSync(absolutePath);
    if (!info.isFile()) return null;

    if (info.size > MAX_SNAPSHOT_BYTES) {
      return { path: relativePath, absolutePath, existed: true, skipped: true };
    }

    return {
      path: relativePath,
      absolutePath,
      existed: true,
      content: readFileSync(absolutePath, "utf-8"),
    };
  } catch {
    return { path: relativePath, absolutePath, existed: true, skipped: true };
  }
}

function writeCheckpoint(checkpoint: Checkpoint) {
  const directory = getSessionDirectory(checkpoint.sessionId);
  mkdirSync(directory, { recursive: true });

  const path = join(directory, `${checkpoint.id}.json`);
  const temporaryPath = `${path}.tmp`;

  writeFileSync(temporaryPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function prune(sessionId: string) {
  const directory = getSessionDirectory(sessionId);
  if (!existsSync(directory)) return;

  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort();

  for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_CHECKPOINTS_PER_SESSION))) {
    try {
      rmSync(join(directory, entry), { force: true });
    } catch {
      // A checkpoint that cannot be deleted is not worth failing a tool call.
    }
  }
}

let counter = 0;

function nextCheckpointId() {
  counter += 1;
  // Sorting by id has to sort by time, so the timestamp comes first and the
  // counter only breaks ties inside the same millisecond.
  return `${Date.now().toString().padStart(14, "0")}-${String(counter).padStart(4, "0")}`;
}

/**
 * Snapshots the files a write tool is about to touch. Returns null when the
 * call does not write, or when there is nothing to record.
 */
export function createCheckpoint(
  sessionId: string,
  toolName: string,
  input: unknown,
): Checkpoint | null {
  if (!isWriteTool(toolName)) return null;

  const paths = collectTargetPaths(toolName, input);
  if (paths.length === 0) return null;

  const cwd = process.cwd();
  const files = paths
    .map((path) => snapshotFile(cwd, path))
    .filter((file): file is CheckpointFile => file !== null);

  if (files.length === 0) return null;

  const checkpoint: Checkpoint = {
    id: nextCheckpointId(),
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    label: describeToolCall(toolName, input),
    toolName,
    files,
  };

  try {
    writeCheckpoint(checkpoint);
    prune(sessionId);
  } catch {
    // Checkpointing is a safety net, not a precondition: a failure to write one
    // must not stop the edit the user already approved.
    return null;
  }

  return checkpoint;
}

export function listCheckpoints(sessionId: string): CheckpointSummary[] {
  const directory = getSessionDirectory(sessionId);
  if (!existsSync(directory)) return [];

  const summaries: CheckpointSummary[] = [];

  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;

    try {
      const checkpoint = JSON.parse(
        readFileSync(join(directory, entry), "utf-8"),
      ) as Checkpoint;

      summaries.push({
        id: checkpoint.id,
        createdAt: checkpoint.createdAt,
        label: checkpoint.label,
        toolName: checkpoint.toolName,
        files: checkpoint.files.map((file) => file.path),
      });
    } catch {
      // Skip a checkpoint that was interrupted mid-write.
    }
  }

  // Newest first: the edit a user wants to undo is almost always the last one.
  return summaries.sort((left, right) => right.id.localeCompare(left.id));
}

function readCheckpoint(sessionId: string, id: string): Checkpoint | null {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) return null;

  try {
    return JSON.parse(
      readFileSync(join(getSessionDirectory(sessionId), `${safeId}.json`), "utf-8"),
    ) as Checkpoint;
  } catch {
    return null;
  }
}

export type RestoreResult = {
  restored: string[];
  deleted: string[];
  skipped: string[];
};

/**
 * Puts every file in the checkpoint back the way it was. Files the tool call
 * created are deleted, because "back the way it was" means they did not exist.
 */
export function restoreCheckpoint(sessionId: string, id: string): RestoreResult {
  const checkpoint = readCheckpoint(sessionId, id);
  if (!checkpoint) {
    throw new Error("That checkpoint no longer exists");
  }

  const result: RestoreResult = { restored: [], deleted: [], skipped: [] };

  for (const file of checkpoint.files) {
    if (file.skipped || (file.existed && file.content === undefined)) {
      result.skipped.push(file.path);
      continue;
    }

    try {
      if (!file.existed) {
        if (existsSync(file.absolutePath)) {
          rmSync(file.absolutePath, { force: true });
          result.deleted.push(file.path);
        }
        continue;
      }

      mkdirSync(dirname(file.absolutePath), { recursive: true });
      writeFileSync(file.absolutePath, file.content ?? "", "utf-8");
      result.restored.push(file.path);
    } catch {
      result.skipped.push(file.path);
    }
  }

  return result;
}

/**
 * Restores every checkpoint from the newest back to `id` inclusive, so undoing
 * a change made three edits ago also undoes the two on top of it.
 */
export function rewindTo(sessionId: string, id: string): RestoreResult {
  const summaries = listCheckpoints(sessionId);
  const targetIndex = summaries.findIndex((summary) => summary.id === id);

  if (targetIndex === -1) {
    throw new Error("That checkpoint no longer exists");
  }

  const merged: RestoreResult = { restored: [], deleted: [], skipped: [] };

  // Newest first, so each older snapshot overwrites the newer one and the file
  // ends up in its oldest recorded state.
  for (const summary of summaries.slice(0, targetIndex + 1)) {
    const result = restoreCheckpoint(sessionId, summary.id);
    merged.restored.push(...result.restored);
    merged.deleted.push(...result.deleted);
    merged.skipped.push(...result.skipped);
  }

  return {
    restored: [...new Set(merged.restored)],
    deleted: [...new Set(merged.deleted)].filter((path) => !merged.restored.includes(path)),
    skipped: [...new Set(merged.skipped)],
  };
}
