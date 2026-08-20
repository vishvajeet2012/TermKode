import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import {
  computeFileDiff,
  formatFileDiff,
  isReadOnlyTool,
  toolInputSchemas,
  Mode,
  type ModeType,
} from "@termkode/shared";
import { getShellCommand } from "@termkode/server";
import { getTermkodeHome } from "./env";
import {
  killBackgroundShell,
  readBackgroundOutput,
  startBackgroundShell,
} from "./background-shells";

const MAX_FILE_SIZE = 10_000;
// Enough of a diff to review an edit at a glance without spending the context
// window on a file the model already knows.
const MAX_DIFF_LINES = 40;
const MAX_RESULTS = 200;
const MAX_MATCHES = 50;
const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_FETCH_LENGTH = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PDF_LENGTH = 40_000;
// A browser user agent keeps search and documentation sites from serving a
// stripped-down or blocked response.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// Strip markup so the model reads the page instead of its HTML.
function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'");
}

function requireHttpUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provide an absolute URL, for example https://example.com");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be fetched");
  }

  return url;
}

// DuckDuckGo's HTML endpoint needs no API key, which keeps search working out
// of the box on a fresh install.
function parseDuckDuckGoResults(html: string, limit: number) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // The class attribute carries several classes, so match the marker itself
  // rather than an exact attribute value.
  const blocks = html.split("result__body").slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!linkMatch) continue;

    const snippetMatch = block.match(
      /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/,
    );

    let href = decodeHtmlEntities(linkMatch[1] ?? "");
    // Results are wrapped in a redirect: //duckduckgo.com/l/?uddg=<encoded>
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect?.[1]) href = decodeURIComponent(redirect[1]);
    if (href.startsWith("//")) href = `https:${href}`;

    const title = decodeHtmlEntities(htmlToText(linkMatch[2] ?? ""));
    const snippet = snippetMatch
      ? decodeHtmlEntities(htmlToText(snippetMatch[1] ?? ""))
      : "";

    if (!title || !href.startsWith("http")) continue;

    results.push({ title, url: href, snippet });
    if (results.length >= limit) break;
  }

  return results;
}

// The task list is per project, so switching projects does not inherit an
// unrelated plan.
function getTodoPath() {
  const key = process.cwd().replace(/[^A-Za-z0-9]/g, "_").slice(-80);
  return join(getTermkodeHome(), "todos", `${key}.json`);
}

function resolveInsideCwd(path: string) {
  const cwd = process.cwd();
  const resolved = resolve(cwd, path);
  const rel = relative(cwd, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the project directory");
  }

  return { cwd, resolved };
}

// Windows console tools (PowerShell, wmic, wsl) write UTF-16LE, which decodes
// as text with a NUL between every character if it is read as UTF-8.
function decodeOutput(bytes: Uint8Array) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, 256));
  let nulls = 0;
  for (let index = 1; index < sample.length; index += 2) {
    if (sample[index] === 0) nulls += 1;
  }

  return sample.length > 8 && nulls > sample.length / 4
    ? Buffer.from(bytes).toString("utf16le")
    : Buffer.from(bytes).toString("utf8");
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  return decodeOutput(new Uint8Array(await new Response(stream).arrayBuffer()));
}

function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}

// Every write reports the diff it produced. The terminal renders it as +/-
// lines so a change is reviewed rather than assumed, and the model sees what
// actually landed instead of trusting the edit it asked for.
function describeEdit(path: string, before: string, after: string) {
  const diff = computeFileDiff(path, before, after, { maxLines: MAX_DIFF_LINES });

  return {
    diff: formatFileDiff(diff),
    linesAdded: diff.added,
    linesRemoved: diff.removed,
  };
}

async function readFileIfExists(path: string) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export async function executeLocalTool(
  toolName: string,
  input: unknown,
  mode: ModeType,
) {
  if (mode === Mode.PLAN && !isReadOnlyTool(toolName)) {
    throw new Error(`Tool ${toolName} is not available in PLAN mode`);
  }

  switch (toolName) {
    case "readFile": {
      const { path } = toolInputSchemas.readFile.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");
      return content.length > MAX_FILE_SIZE
        ? {
            content: content.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalLength: content.length,
          }
        : { content };
    }

    case "listDirectory": {
      const { path } = toolInputSchemas.listDirectory.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const entries = await readdir(resolved);
      const results: { name: string; type: "file" | "directory" }[] = [];

      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const info = await stat(join(resolved, entry));
        results.push({
          name: entry,
          type: info.isDirectory() ? "directory" : "file",
        });
      }

      results.sort((a, b) =>
        a.type !== b.type
          ? a.type === "directory"
            ? -1
            : 1
          : a.name.localeCompare(b.name),
      );
      return { path: relative(cwd, resolved) || ".", entries: results };
    }

    case "glob": {
      const { pattern, path } = toolInputSchemas.glob.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const glob = new Bun.Glob(pattern);
      const files: string[] = [];
      let truncated = false;

      for await (const match of glob.scan({
        cwd: resolved,
        dot: false,
        onlyFiles: true,
      })) {
        if (match.includes("node_modules")) continue;
        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
        files.push(relative(cwd, resolve(resolved, match)));
      }

      files.sort();
      return { files, ...(truncated ? { truncated: true } : {}) };
    }

    case "grep": {
      const { pattern, path, include } = toolInputSchemas.grep.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const args = [
        "-rn",
        "--color=never",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "-E",
      ];
      if (include) args.push(`--include=${include}`);
      args.push(pattern, resolved);

      const proc = Bun.spawn(["grep", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(`grep failed: ${stderr.trim()}`);
      }
      if (!stdout.trim()) {
        return { matches: [], message: "No matches found" };
      }

      const lines = stdout.split("\n").filter(Boolean);
      const matches: { file: string; line: number; content: string }[] = [];
      let truncated = false;

      for (const line of lines) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          matches.push({
            file: relative(cwd, match[1]!),
            line: Number(match[2]),
            content: match[3]!,
          });
        }
      }

      return {
        matches,
        ...(truncated
          ? { truncated: true, totalMatches: lines.length }
          : {}),
      };
    }

    case "writeFile": {
      const { path, content } = toolInputSchemas.writeFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const relativePath = relative(cwd, resolved);
      const previous = await readFileIfExists(resolved);

      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");

      return {
        success: true as const,
        path: relativePath,
        created: previous === null,
        bytesWritten: Buffer.byteLength(content, "utf-8"),
        // A new file is its own diff; only an overwrite needs one.
        ...(previous === null
          ? {}
          : describeEdit(relativePath, previous, content)),
      };
    }

    case "editFile": {
      const { path, oldString, newString } =
        toolInputSchemas.editFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) throw new Error("oldString not found in file");
      if (occurrences > 1)
        throw new Error(
          `oldString is ambiguous; found ${occurrences} matches`,
        );

      const relativePath = relative(cwd, resolved);
      const updated = content.replace(oldString, newString);
      await writeFile(resolved, updated, "utf-8");

      return {
        success: true as const,
        path: relativePath,
        ...describeEdit(relativePath, content, updated),
      };
    }

    case "multiEdit": {
      const { edits } = toolInputSchemas.multiEdit.parse(input);
      const files = new Map<string, { resolved: string; content: string }>();
      const originals = new Map<string, string>();

      // Apply every edit in memory first so a later failure cannot leave the
      // project half-edited.
      for (const [index, edit] of edits.entries()) {
        const { cwd, resolved } = resolveInsideCwd(edit.path);
        const existing = files.get(resolved)?.content;
        const current = existing ?? (await readFile(resolved, "utf-8"));
        if (existing === undefined) originals.set(resolved, current);
        const occurrences = current.split(edit.oldString).length - 1;

        if (occurrences === 0) {
          throw new Error(
            `Edit ${index + 1} (${relative(cwd, resolved)}): oldString not found`,
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `Edit ${index + 1} (${relative(cwd, resolved)}): oldString is ambiguous; found ${occurrences} matches`,
          );
        }

        files.set(resolved, {
          resolved,
          content: current.replace(edit.oldString, edit.newString),
        });
      }

      const cwd = process.cwd();
      for (const file of files.values()) {
        await writeFile(file.resolved, file.content, "utf-8");
      }

      const diffs = [...files.values()].map((file) => {
        const relativePath = relative(cwd, file.resolved);
        return describeEdit(
          relativePath,
          originals.get(file.resolved) ?? "",
          file.content,
        );
      });

      return {
        success: true as const,
        editsApplied: edits.length,
        files: [...files.values()].map((file) => relative(cwd, file.resolved)),
        diff: diffs.map((entry) => entry.diff).join("\n\n"),
        linesAdded: diffs.reduce((total, entry) => total + entry.linesAdded, 0),
        linesRemoved: diffs.reduce((total, entry) => total + entry.linesRemoved, 0),
      };
    }

    case "fetchUrl": {
      const { url, maxLength = MAX_FETCH_LENGTH } =
        toolInputSchemas.fetchUrl.parse(input);
      const target = requireHttpUrl(url);

      const response = await fetch(target, {
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const text = contentType.includes("html") ? htmlToText(body) : body.trim();

      return {
        url: response.url,
        status: response.status,
        contentType,
        content: truncate(text, Math.min(maxLength, MAX_FETCH_LENGTH)),
      };
    }

    case "webSearch": {
      const { query, maxResults = 5 } = toolInputSchemas.webSearch.parse(input);
      const response = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Search failed with status ${response.status}`);
      }

      const results = parseDuckDuckGoResults(
        await response.text(),
        Math.max(1, Math.min(maxResults, 10)),
      );

      return {
        query,
        results,
        ...(results.length === 0
          ? { note: "No results parsed. Use fetchUrl on a known URL instead." }
          : {}),
      };
    }

    case "readPdf": {
      const { path, maxLength = MAX_PDF_LENGTH } =
        toolInputSchemas.readPdf.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const { extractText, getDocumentProxy } = await import("unpdf");
      const document = await getDocumentProxy(
        new Uint8Array(await readFile(resolved)),
      );
      const { text, totalPages } = await extractText(document, { mergePages: true });

      return {
        pages: totalPages,
        content: truncate(text, Math.min(maxLength, MAX_PDF_LENGTH)),
      };
    }

    case "todoWrite": {
      const { todos } = toolInputSchemas.todoWrite.parse(input);
      const path = getTodoPath();

      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ cwd: process.cwd(), todos }, null, 2),
        "utf-8",
      );

      return {
        todos,
        remaining: todos.filter((todo) => todo.status !== "completed").length,
      };
    }

    case "bash": {
      const { command, timeout = DEFAULT_TIMEOUT, background = false } =
        toolInputSchemas.bash.parse(input);

      // A dev server or a watcher never exits, so waiting for it would only
      // produce a timeout. Start it, hand back an id, and let bashOutput read
      // what it prints.
      if (background) {
        const { id, ...started } = startBackgroundShell(
          command,
          resolveInsideCwd(".").resolved,
        );

        return {
          backgroundId: id,
          ...started,
          note: "Started in the background. Read its output with bashOutput, and stop it with killBash when you are done.",
        };
      }

      // Windows without Git Bash falls back to PowerShell, so the tool works
      // on a plain install instead of failing to spawn.
      const proc = Bun.spawn(getShellCommand(command), {
        cwd: resolveInsideCwd(".").resolved,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });
      const timer = setTimeout(() => proc.kill(), timeout);
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return {
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode,
      };
    }

    case "bashOutput": {
      const { id, filter } = toolInputSchemas.bashOutput.parse(input);
      const output = readBackgroundOutput(id, filter);

      return {
        ...output,
        stdout: truncate(output.stdout, MAX_OUTPUT),
        stderr: truncate(output.stderr, MAX_OUTPUT),
      };
    }

    case "killBash": {
      const { id } = toolInputSchemas.killBash.parse(input);
      const output = await killBackgroundShell(id);

      return {
        ...output,
        stopped: true as const,
        stdout: truncate(output.stdout, MAX_OUTPUT),
        stderr: truncate(output.stderr, MAX_OUTPUT),
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
