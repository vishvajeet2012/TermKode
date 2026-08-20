import type { Subprocess } from "bun";
import { getShellCommand } from "@termkode/server";

// A dev server, a watcher, or a long build never returns, so running one through
// the ordinary `bash` tool means waiting for a timeout and getting nothing. A
// background command is started here instead: the tool returns an id straight
// away, output is collected as it arrives, and `bashOutput` hands back whatever
// is new since the last read.
//
// The registry lives in the CLI process, which is the same process the tools run
// in, so an id stays valid for as long as TermKode is open - and every process
// is stopped when it closes, so nothing is left holding a port.

/** Output kept per stream. Old output is dropped rather than growing forever. */
const MAX_BUFFER_CHARACTERS = 200_000;
/** How long a stopped process waits before it is killed outright. */
const KILL_GRACE_MS = 2_000;

type StreamBuffer = {
  /** Everything received so far, capped at MAX_BUFFER_CHARACTERS. */
  text: string;
  /** How much of `text` has already been handed to the model. */
  readOffset: number;
  /** Characters dropped off the front to stay within the cap. */
  dropped: number;
  decoder: TextDecoder;
};

type BackgroundShell = {
  id: string;
  command: string;
  pid: number | undefined;
  startedAt: number;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  stdout: StreamBuffer;
  stderr: StreamBuffer;
  exitCode: number | null;
  stoppedByUs: boolean;
};

export type BackgroundStatus = {
  id: string;
  command: string;
  pid?: number;
  running: boolean;
  exitCode: number | null;
  runningForMs: number;
};

export type BackgroundOutput = BackgroundStatus & {
  /** Output produced since the previous read. */
  stdout: string;
  stderr: string;
  /** Set when older output was dropped to stay within the buffer cap. */
  droppedCharacters?: number;
  /** Set when a filter was applied and removed every line. */
  note?: string;
};

const shells = new Map<string, BackgroundShell>();
let counter = 0;

function newBuffer(): StreamBuffer {
  return { text: "", readOffset: 0, dropped: 0, decoder: new TextDecoder("utf-8") };
}

function append(buffer: StreamBuffer, chunk: Uint8Array) {
  // Windows console tools emit UTF-16LE, which reads as text with a NUL between
  // every character if it is decoded as UTF-8. The BOM only appears on the first
  // chunk, so the decoder is swapped once and then left alone. "utf-16" is the
  // encoding standard's label for little-endian, and it consumes the BOM itself.
  if (buffer.text === "" && chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
    buffer.decoder = new TextDecoder("utf-16");
  }

  buffer.text += buffer.decoder.decode(chunk, { stream: true });

  if (buffer.text.length > MAX_BUFFER_CHARACTERS) {
    const overflow = buffer.text.length - MAX_BUFFER_CHARACTERS;
    buffer.text = buffer.text.slice(overflow);
    buffer.dropped += overflow;
    buffer.readOffset = Math.max(0, buffer.readOffset - overflow);
  }
}

async function pump(stream: ReadableStream<Uint8Array>, buffer: StreamBuffer) {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) append(buffer, value);
    }
  } catch {
    // The process was killed mid-read. Whatever arrived is still readable.
  } finally {
    reader.releaseLock();
  }
}

function takeNew(buffer: StreamBuffer) {
  const text = buffer.text.slice(buffer.readOffset);
  buffer.readOffset = buffer.text.length;
  return text;
}

function isRunning(shell: BackgroundShell) {
  return shell.exitCode === null;
}

function toStatus(shell: BackgroundShell): BackgroundStatus {
  return {
    id: shell.id,
    command: shell.command,
    ...(shell.pid ? { pid: shell.pid } : {}),
    running: isRunning(shell),
    exitCode: shell.exitCode,
    runningForMs: Date.now() - shell.startedAt,
  };
}

export function startBackgroundShell(command: string, cwd: string): BackgroundStatus {
  counter += 1;
  const id = `bg_${counter}`;

  const proc = Bun.spawn(getShellCommand(command), {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", CI: "1", FORCE_COLOR: "0" },
  });

  const shell: BackgroundShell = {
    id,
    command,
    pid: proc.pid,
    startedAt: Date.now(),
    proc,
    stdout: newBuffer(),
    stderr: newBuffer(),
    exitCode: null,
    stoppedByUs: false,
  };

  shells.set(id, shell);

  void pump(proc.stdout, shell.stdout);
  void pump(proc.stderr, shell.stderr);
  void proc.exited.then((code) => {
    shell.exitCode = code;
  });

  return toStatus(shell);
}

function describeKnownIds() {
  const ids = [...shells.values()].map(
    (shell) => `${shell.id} (${isRunning(shell) ? "running" : "finished"})`,
  );

  return ids.length > 0 ? ` Known ids: ${ids.join(", ")}.` : " Nothing is running.";
}

function requireShell(id: string) {
  const shell = shells.get(id);
  if (!shell) {
    throw new Error(`No background command with id "${id}".${describeKnownIds()}`);
  }
  return shell;
}

function applyFilter(text: string, filter: string) {
  let pattern: RegExp;
  try {
    pattern = new RegExp(filter);
  } catch {
    throw new Error(`filter is not a valid regular expression: ${filter}`);
  }

  return text
    .split("\n")
    .filter((line) => pattern.test(line))
    .join("\n");
}

export function readBackgroundOutput(id: string, filter?: string): BackgroundOutput {
  const shell = requireShell(id);

  const droppedBefore = shell.stdout.dropped + shell.stderr.dropped;
  let stdout = takeNew(shell.stdout);
  let stderr = takeNew(shell.stderr);
  const hadOutput = Boolean(stdout || stderr);

  if (filter) {
    stdout = applyFilter(stdout, filter);
    stderr = applyFilter(stderr, filter);
  }

  return {
    ...toStatus(shell),
    stdout,
    stderr,
    ...(droppedBefore > 0 ? { droppedCharacters: droppedBefore } : {}),
    ...(filter && hadOutput && !stdout && !stderr
      ? { note: "New output arrived but no line matched the filter." }
      : {}),
  };
}

async function killTree(shell: BackgroundShell) {
  if (process.platform === "win32" && shell.pid) {
    // Killing the shell alone leaves the server it started holding the port, so
    // Windows needs the whole tree.
    try {
      Bun.spawn(["taskkill", "/PID", String(shell.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    } catch {
      // Fall through to the ordinary signal.
    }
  }

  try {
    shell.proc.kill();
  } catch {
    // Already gone.
  }
}

export async function killBackgroundShell(id: string): Promise<BackgroundOutput> {
  const shell = requireShell(id);

  if (!isRunning(shell)) {
    return { ...readBackgroundOutput(id), running: false };
  }

  shell.stoppedByUs = true;
  await killTree(shell);

  // Give it a moment to exit cleanly, then stop waiting: the caller should not
  // hang because a process ignored its signal.
  await Promise.race([
    shell.proc.exited,
    new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
  ]);

  if (isRunning(shell)) {
    try {
      shell.proc.kill(9);
    } catch {
      // Nothing else to try.
    }
  }

  return readBackgroundOutput(id);
}

export function listBackgroundShells(): BackgroundStatus[] {
  return [...shells.values()].map(toStatus);
}

/** Stops everything still running. Called when TermKode exits. */
export function stopAllBackgroundShells() {
  for (const shell of shells.values()) {
    if (isRunning(shell)) void killTree(shell);
  }
}

/** Test hook: forget every recorded process after stopping it. */
export function resetBackgroundShells() {
  stopAllBackgroundShells();
  shells.clear();
  counter = 0;
}

// A dev server that outlives the terminal it was started from is a port nobody
// can free without hunting for the process, so exit takes them with it.
let exitHooksInstalled = false;

if (!exitHooksInstalled) {
  exitHooksInstalled = true;

  process.on("exit", stopAllBackgroundShells);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopAllBackgroundShells();
      process.exit(0);
    });
  }
}
