import {
  EMPTY_PERMISSION_RULES,
  evaluatePermission,
  type PermissionEvaluation,
  type PermissionRules,
} from "@termkode/shared";
import { apiClient } from "./api-client";
import { shouldSkipPermissions } from "./runtime-flags";

// The approval prompt is only worth showing if the answer sticks, so the rules
// live on disk and are cached here for the lifetime of the process. Every tool
// call reads this cache, which is why it is refreshed the moment a rule is
// added rather than on a timer.

let cached: PermissionRules = { ...EMPTY_PERMISSION_RULES, allow: [], deny: [] };
let loaded: Promise<PermissionRules> | null = null;

async function fetchRules(): Promise<PermissionRules> {
  try {
    const response = await apiClient.permissions.$get();
    if (!response.ok) return cached;

    cached = await response.json();
    return cached;
  } catch {
    // Without stored rules every risky call is asked, which is the safe
    // direction to fail in.
    return cached;
  }
}

export function loadPermissionRules(): Promise<PermissionRules> {
  loaded ??= fetchRules();
  return loaded;
}

/** Refetches from disk, for the dialog that lists what has been granted. */
export async function refreshPermissionRules(): Promise<PermissionRules> {
  loaded = fetchRules();
  return loaded;
}

export async function rememberAllowRule(rule: string): Promise<PermissionRules> {
  const response = await apiClient.permissions.allow.$post({ json: { rule } });
  if (!response.ok) {
    throw new Error("Could not save that permission");
  }

  cached = await response.json();
  loaded = Promise.resolve(cached);
  return cached;
}

export async function rememberDenyRule(rule: string): Promise<PermissionRules> {
  const response = await apiClient.permissions.deny.$post({ json: { rule } });
  if (!response.ok) {
    throw new Error("Could not save that permission");
  }

  cached = await response.json();
  loaded = Promise.resolve(cached);
  return cached;
}

export async function forgetPermissionRule(rule: string): Promise<PermissionRules> {
  const response = await apiClient.permissions.forget.$post({ json: { rule } });
  if (!response.ok) {
    throw new Error("Could not remove that permission");
  }

  cached = await response.json();
  loaded = Promise.resolve(cached);
  return cached;
}

export async function clearPermissionRules(): Promise<PermissionRules> {
  const response = await apiClient.permissions.$delete();
  if (!response.ok) {
    throw new Error("Could not clear permissions");
  }

  cached = await response.json();
  loaded = Promise.resolve(cached);
  return cached;
}

/** What should happen to this call, given the rules stored so far. */
export function decidePermission(toolName: string, input: unknown): PermissionEvaluation {
  return evaluatePermission({
    toolName,
    input,
    rules: cached,
    skipPrompts: shouldSkipPermissions(),
  });
}
