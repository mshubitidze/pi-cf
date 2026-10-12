import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  ChatState,
  ChatUnavailable,
  ConnectionMissing,
  OperationId,
  Outcome,
  Receipt,
  Submission,
  ModelSettings,
  SettingsRejected,
  SessionId,
  WorkspaceState,
  CreateSession,
  SessionCreated,
  UpdateSession,
  SharedMemory,
  WorkspaceRejected,
} from "./model.ts";

/** Personal conversation capability; the host owns persistence and deduplication. */
export class Conversation extends Context.Service<
  Conversation,
  {
    readonly read: (sessionId: SessionId) => Effect.Effect<ChatState, ChatUnavailable>;
    readonly submit: (
      input: Submission,
      sessionId: SessionId,
    ) => Effect.Effect<Receipt, ChatUnavailable | ConnectionMissing | WorkspaceRejected>;
    readonly result: (
      id: OperationId,
      sessionId: SessionId,
    ) => Effect.Effect<Outcome, ChatUnavailable>;
    readonly configure: (
      settings: ModelSettings,
      sessionId: SessionId,
    ) => Effect.Effect<ChatState, ChatUnavailable | SettingsRejected | WorkspaceRejected>;
    readonly workspace: Effect.Effect<WorkspaceState, ChatUnavailable>;
    readonly createSession: (
      input: CreateSession,
    ) => Effect.Effect<SessionCreated, ChatUnavailable | WorkspaceRejected>;
    readonly updateSession: (
      id: SessionId,
      input: UpdateSession,
    ) => Effect.Effect<WorkspaceState, ChatUnavailable | WorkspaceRejected>;
    readonly saveMemory: (
      input: SharedMemory,
    ) => Effect.Effect<WorkspaceState, ChatUnavailable | WorkspaceRejected>;
    readonly stop: (id: SessionId) => Effect.Effect<ChatState, ChatUnavailable | WorkspaceRejected>;
  }
>()("pi/Conversation") {}
