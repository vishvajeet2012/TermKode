import { existsSync } from "node:fs";

// The API runs inside the CLI process, so the machine described here is the
// one the user is sitting at. The agent needs to know it: without an OS and a
// shell it writes Linux commands on Windows, or refuses machine questions it
// could have answered with one command.
export type ShellInfo = {
  label: string;
  syntax: string;
  argv: (command: string) => string[];
};

let cachedShell: ShellInfo | undefined;

// C:\Windows\System32\bash.exe is the WSL launcher, not a shell. It comes
// first on PATH for most Windows users, and on a machine with no installed
// distribution every command fails with "Windows Subsystem for Linux has no
// installed distributions" - which the agent then tries to interpret.
const GIT_BASH_PATHS = [
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
];

function isWslLauncher(path: string) {
  return /[\\/]System32[\\/]bash\.exe$/i.test(path);
}

function findBash() {
  try {
    const onPath = Bun.which("bash");
    if (onPath && !isWslLauncher(onPath)) return onPath;
  } catch {
    // Fall through to the known install locations.
  }

  for (const candidate of GIT_BASH_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

export function getShell(): ShellInfo {
  if (cachedShell) return cachedShell;

  if (process.platform !== "win32") {
    cachedShell = {
      label: "bash",
      syntax: "POSIX shell",
      argv: (command) => ["bash", "-c", command],
    };
    return cachedShell;
  }

  // Git Bash gives Windows the POSIX commands models expect. PowerShell is the
  // fallback, and is the better tool for Windows system queries anyway.
  const bash = findBash();
  cachedShell = bash
    ? {
        label: "Git Bash",
        syntax: "POSIX shell",
        argv: (command) => [bash, "-c", command],
      }
    : {
        label: "PowerShell",
        syntax: "PowerShell",
        argv: (command) => [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ],
      };

  return cachedShell;
}

export function getShellCommand(command: string) {
  return getShell().argv(command);
}

const OS_NAMES: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

export function describeEnvironment(cwd?: string) {
  const shell = getShell();

  return {
    os: OS_NAMES[process.platform] ?? process.platform,
    platform: process.platform,
    arch: process.arch,
    shell: shell.label,
    shellSyntax: shell.syntax,
    cwd: cwd ?? process.cwd(),
  };
}
