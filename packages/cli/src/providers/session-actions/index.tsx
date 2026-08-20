import { createContext, useContext, type ReactNode } from "react";

// The input bar is shared by the home screen and by an open conversation, so
// commands that only make sense inside a session - /compact, /rewind - ask for
// these actions and get null when there is no session to act on.

export type SessionActions = {
  sessionId: string;
  /** Summarizes the older turns and replaces them in place. */
  compact: (instructions?: string) => Promise<void>;
  /** Reloads the conversation from disk, after something changed it. */
  reload: () => Promise<void>;
};

const SessionActionsContext = createContext<SessionActions | null>(null);

export function useSessionActions(): SessionActions | null {
  return useContext(SessionActionsContext);
}

export function SessionActionsProvider({
  value,
  children,
}: {
  value: SessionActions;
  children: ReactNode;
}) {
  return (
    <SessionActionsContext.Provider value={value}>{children}</SessionActionsContext.Provider>
  );
}
