import { useCallback, useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EMPTY_PERMISSION_RULES, type PermissionRules } from "@termkode/shared";
import { useToast } from "../../providers/toast";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { DialogSearchList } from "../dialog-search-list";
import {
  clearPermissionRules,
  forgetPermissionRule,
  refreshPermissionRules,
} from "../../lib/permissions";
import { shouldSkipPermissions } from "../../lib/runtime-flags";

// `/permissions` - what the user has already agreed to. A rule that cannot be
// found and removed is a rule the user has lost track of, which is why every
// grant is listed here rather than only in the JSON file.

type RuleEntry = {
  rule: string;
  kind: "allow" | "deny";
};

function toEntries(rules: PermissionRules): RuleEntry[] {
  return [
    ...rules.allow.map((rule) => ({ rule, kind: "allow" as const })),
    ...rules.deny.map((rule) => ({ rule, kind: "deny" as const })),
  ];
}

export const PermissionsDialogContent = () => {
  const toast = useToast();
  const { isTopLayer } = useKeyboardLayer();
  const [rules, setRules] = useState<PermissionRules>(EMPTY_PERMISSION_RULES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    void refreshPermissionRules()
      .then((next) => {
        if (!ignore) setRules(next);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

  const handleSelect = useCallback(
    (entry: RuleEntry) => {
      void forgetPermissionRule(entry.rule)
        .then((next) => {
          setRules(next);
          toast.show({ variant: "success", message: `Removed "${entry.rule}"` });
        })
        .catch((error: unknown) => {
          toast.show({
            variant: "error",
            message: error instanceof Error ? error.message : "Could not remove that rule",
          });
        });
    },
    [toast],
  );

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    // ctrl+d clears everything, for when a user wants a clean slate rather than
    // to pick through a long list.
    if (key.name === "d" && key.ctrl) {
      key.preventDefault();
      void clearPermissionRules()
        .then((next) => {
          setRules(next);
          toast.show({ variant: "success", message: "Cleared every stored permission" });
        })
        .catch(() => {
          toast.show({ variant: "error", message: "Could not clear permissions" });
        });
    }
  });

  const entries = toEntries(rules);

  return (
    <box flexDirection="column" gap={1}>
      {shouldSkipPermissions() ? (
        <text fg="red">
          Started with --yolo: every tool runs without asking, whatever is listed here.
        </text>
      ) : null}

      {loading ? (
        <text attributes={TextAttributes.DIM}>Loading…</text>
      ) : entries.length === 0 ? (
        <text attributes={TextAttributes.DIM}>
          Nothing has been granted yet. Choosing "always allow" on an approval
          prompt records a rule here.
        </text>
      ) : (
        <>
          <text attributes={TextAttributes.DIM}>
            Enter removes a rule. ctrl+d removes all of them.
          </text>
          <DialogSearchList
            items={entries}
            onSelect={handleSelect}
            filterFn={(item, query) => item.rule.toLowerCase().includes(query.toLowerCase())}
            renderItem={(item, isSelected) => (
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {item.kind === "deny" ? "deny  " : "allow "}
                {item.rule}
              </text>
            )}
            getKey={(item) => `${item.kind}:${item.rule}`}
            placeholder="Search permissions"
            emptyText="No matching permissions"
            maxVisibleItems={8}
          />
        </>
      )}
    </box>
  );
};
