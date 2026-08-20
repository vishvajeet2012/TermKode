import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_PERMISSION_RULES,
  addAllowRule,
  addDenyRule,
  removeRule,
  type PermissionRules,
} from "@termkode/shared";
import { getHomeDirectory } from "./paths";

// "Always allow" has to survive a restart or it is not worth offering. Rules
// live in their own file rather than config.json so a user can read, edit, or
// delete what they have granted without going near their API keys.

const PERMISSIONS_FILE_NAME = "permissions.json";

function getPermissionsPath() {
  return join(getHomeDirectory(), PERMISSIONS_FILE_NAME);
}

function sanitizeRules(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function readPermissionRules(): PermissionRules {
  try {
    const parsed = JSON.parse(readFileSync(getPermissionsPath(), "utf-8")) as Partial<PermissionRules>;

    return {
      version: 1,
      allow: sanitizeRules(parsed.allow),
      deny: sanitizeRules(parsed.deny),
    };
  } catch {
    // No file yet, or a file someone edited into invalid JSON. Either way the
    // safe reading is "nothing has been granted".
    return { ...EMPTY_PERMISSION_RULES, allow: [], deny: [] };
  }
}

function writePermissionRules(rules: PermissionRules) {
  const path = getPermissionsPath();
  const temporaryPath = `${path}.tmp`;

  writeFileSync(temporaryPath, JSON.stringify(rules, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function allowRule(rule: string): PermissionRules {
  // Granting something that was previously refused should not leave both.
  const next = addAllowRule(removeRule(readPermissionRules(), rule), rule);
  writePermissionRules(next);
  return next;
}

export function denyRule(rule: string): PermissionRules {
  const next = addDenyRule(removeRule(readPermissionRules(), rule), rule);
  writePermissionRules(next);
  return next;
}

export function forgetRule(rule: string): PermissionRules {
  const next = removeRule(readPermissionRules(), rule);
  writePermissionRules(next);
  return next;
}

export function clearPermissionRules(): PermissionRules {
  const next: PermissionRules = { version: 1, allow: [], deny: [] };
  writePermissionRules(next);
  return next;
}
