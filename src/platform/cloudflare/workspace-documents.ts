import { defineDoc } from "@earendil-works/pi-durable";

/** Editable memory shared by all conversations in the personal Pi storage. */
export const MemoryDoc = defineDoc({
  kind: "personal.memory",
  version: 1,
  scope: "session",
  initial: () => ({ text: "", revision: 0 }),
});

/** Conversation presentation; a fork starts with fresh title and archive state. */
export const SessionMetadataDoc = defineDoc({
  kind: "personal.session-metadata",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): { title: string; archived: boolean } => ({ title: "", archived: false }),
});

/** Atomic creation receipts survive uncertain delivery and Durable Object restarts. */
export const SessionRequestsDoc = defineDoc({
  kind: "personal.session-requests",
  version: 1,
  scope: "session",
  initial: (): {
    requests: Record<string, { sessionId: string; title: string; forkFrom: string }>;
  } => ({ requests: {} }),
});
