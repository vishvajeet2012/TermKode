import { useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { ClipboardUnavailableError, readClipboard } from "../lib/clipboard";

// Where ctrl+v works, the terminal handles it itself and the application never
// sees the key - it receives the pasted text instead. So a ctrl+v that actually
// reaches this handler is proof the terminal did not paste, which is exactly
// when reading the clipboard directly is the right thing to do. There is no
// case where both happen, so this cannot paste twice.

type Options = {
  /** Usually "is this field focused" - a background field must not steal ctrl+v. */
  enabled: boolean;
  onPaste: (text: string) => void;
  /** Shown when there is no clipboard tool to read from. */
  onError?: (message: string) => void;
};

export function useClipboardPaste({ enabled, onPaste, onError }: Options) {
  // Reading the clipboard spawns a process; holding the key down must not start
  // a dozen of them.
  const reading = useRef(false);

  const paste = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;

    try {
      const text = await readClipboard();
      if (text) onPaste(text);
    } catch (error) {
      onError?.(
        error instanceof ClipboardUnavailableError
          ? error.message
          : "Could not read the clipboard.",
      );
    } finally {
      reading.current = false;
    }
  }, [onPaste, onError]);

  useKeyboard((key) => {
    if (!enabled) return;
    if (key.name !== "v" || !key.ctrl || key.meta) return;

    key.preventDefault();
    void paste();
  });
}
