// A terminal only delivers a paste to the application if it supports bracketed
// paste, and OpenTUI reports that as a detected capability rather than
// something it can turn on. On a terminal without it - an older Windows
// console, some minimal emulators - ctrl+v does nothing at all, silently, and
// the user is left wondering why their API key will not go in.
//
// So when the key reaches the application instead of being swallowed by the
// terminal, the clipboard is read directly. That is the same thing the terminal
// would have done, and it works everywhere the platform's own clipboard tool
// does.

const CLIPBOARD_TIMEOUT_MS = 3_000;

// Tried in order; the first one that exists and returns something wins. Linux
// has no single answer, so Wayland is tried before X11.
const READERS: Record<string, string[][]> = {
  win32: [
    // -Raw keeps the text as one string instead of splitting it into lines.
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
  ],
  darwin: [["pbpaste"]],
  linux: [
    ["wl-paste", "--no-newline"],
    ["xclip", "-selection", "clipboard", "-o"],
    ["xsel", "--clipboard", "--output"],
  ],
};

export class ClipboardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipboardUnavailableError";
  }
}

function describeMissingTool(): string {
  if (process.platform === "linux") {
    return "Could not read the clipboard. Install wl-clipboard (Wayland) or xclip (X11), or type the value instead.";
  }

  return "Could not read the clipboard. Type the value instead, or set it as an environment variable.";
}

async function run(command: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

    const timer = setTimeout(() => proc.kill(), CLIPBOARD_TIMEOUT_MS);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) return null;
    return output;
  } catch {
    // The tool is not installed, or could not be spawned.
    return null;
  }
}

/**
 * The clipboard's text content, with the trailing newline the platform tools
 * add removed. Throws when no clipboard tool could be used, so the caller can
 * tell the user what to install rather than appearing to do nothing.
 */
export async function readClipboard(): Promise<string> {
  const readers = READERS[process.platform];
  if (!readers) {
    throw new ClipboardUnavailableError(describeMissingTool());
  }

  for (const command of readers) {
    const output = await run(command);
    if (output === null) continue;

    // Reading an empty clipboard is a real answer, not a failed read.
    return output.replace(/\r?\n$/, "");
  }

  throw new ClipboardUnavailableError(describeMissingTool());
}

/**
 * Prepares clipboard text for a single-line field. A key copied from a web page
 * often carries a trailing newline or stray whitespace, and a newline in a
 * one-line input would otherwise submit the form or be dropped mid-value.
 */
export function toSingleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}
