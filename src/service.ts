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
} from "./model.ts";

/** Personal conversation capability; the host owns persistence and deduplication. */
export class Conversation extends Context.Service<
  Conversation,
  {
    readonly read: Effect.Effect<ChatState, ChatUnavailable>;
    readonly submit: (
      input: Submission,
    ) => Effect.Effect<Receipt, ChatUnavailable | ConnectionMissing>;
    readonly result: (id: OperationId) => Effect.Effect<Outcome, ChatUnavailable>;
    readonly configure: (
      settings: ModelSettings,
    ) => Effect.Effect<ChatState, ChatUnavailable | SettingsRejected>;
  }
>()("pi/Conversation") {}
