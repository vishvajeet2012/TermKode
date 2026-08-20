import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { formatDistanceToNow } from "date-fns";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { listCheckpoints, rewindTo, type CheckpointSummary } from "../../lib/checkpoints";

// `/rewind` - put the files back the way they were before an edit. Restoring an
// older checkpoint also undoes everything written after it, because a file
// cannot be half of two different states.

type RewindDialogContentProps = {
  sessionId: string;
};

export const RewindDialogContent = ({ sessionId }: RewindDialogContentProps) => {
  const dialog = useDialog();
  const toast = useToast();
  const [checkpoints] = useState<CheckpointSummary[]>(() => listCheckpoints(sessionId));

  const handleSelect = useCallback(
    (checkpoint: CheckpointSummary) => {
      try {
        const result = rewindTo(sessionId, checkpoint.id);
        dialog.close();

        const parts = [
          result.restored.length > 0 ? `restored ${result.restored.length}` : null,
          result.deleted.length > 0 ? `removed ${result.deleted.length}` : null,
          result.skipped.length > 0 ? `skipped ${result.skipped.length}` : null,
        ].filter(Boolean);

        toast.show({
          variant: result.skipped.length > 0 ? "info" : "success",
          message: `Rewound to before "${checkpoint.label}" - ${parts.join(", ") || "nothing to change"}. The conversation still describes the undone work; tell the agent what you reverted.`,
        });
      } catch (error) {
        toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : "Could not rewind",
        });
      }
    },
    [sessionId, dialog, toast],
  );

  const describe = useMemo(
    () => (checkpoint: CheckpointSummary) => {
      const when = (() => {
        try {
          return formatDistanceToNow(new Date(checkpoint.createdAt), { addSuffix: true });
        } catch {
          return "";
        }
      })();

      return `${checkpoint.label}${when ? ` · ${when}` : ""}`;
    },
    [],
  );

  if (checkpoints.length === 0) {
    return (
      <box flexDirection="column" gap={1}>
        <text attributes={TextAttributes.DIM}>
          No checkpoints yet. One is taken before every file the agent writes.
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>
        Restores the files as they were before the selected edit, and undoes
        everything written after it.
      </text>
      <DialogSearchList
        items={checkpoints}
        onSelect={handleSelect}
        filterFn={(item, query) => describe(item).toLowerCase().includes(query.toLowerCase())}
        renderItem={(item, isSelected) => (
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {describe(item)}
          </text>
        )}
        getKey={(item) => item.id}
        placeholder="Search checkpoints"
        emptyText="No matching checkpoints"
        maxVisibleItems={8}
      />
    </box>
  );
};
