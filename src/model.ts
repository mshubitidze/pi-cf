import * as Schema from "effect/Schema";

/** An idempotency key that identifies one submitted turn. */
export const OperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{8,80}$/)).pipe(
  Schema.brand("OperationId"),
);
export type OperationId = typeof OperationId.Type;

export const MAX_PROMPT_LENGTH = 8000;

/** Validated input to the personal assistant. */
export const Submission = Schema.Struct({
  operationId: OperationId,
  prompt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PROMPT_LENGTH),
    Schema.isPattern(/\S/),
  ),
});
export type Submission = typeof Submission.Type;

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = typeof ThinkingLevel.Type;
export const ModelSettings = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  thinkingLevel: ThinkingLevel,
});
export type ModelSettings = typeof ModelSettings.Type;
export const ModelChoice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  thinkingLevels: Schema.Array(ThinkingLevel),
});

/** Display projection, excluding credentials and private model reasoning. */
export const ChatState = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
    }),
  ),
  pending: Schema.Array(OperationId),
  connection: Schema.Literals(["connected", "missing"]),
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  models: Schema.Array(ModelChoice),
});
export type ChatState = typeof ChatState.Type;

/** Durable acknowledgement, including whether this was a duplicate delivery. */
export const Receipt = Schema.Struct({ operationId: OperationId, accepted: Schema.Boolean });
export type Receipt = typeof Receipt.Type;

/** A pending operation may outlive the browser waiting for it. */
export const Outcome = Schema.Struct({
  status: Schema.Literals(["pending", "done", "unanswered"]),
});
export type Outcome = typeof Outcome.Type;

/** Sanitized integration failure, safe to cross RPC and HTTP boundaries. */
export class ChatUnavailable extends Schema.TaggedError<ChatUnavailable>()("ChatUnavailable", {
  operation: Schema.String,
}) {}

/** Admission requires a stored provider connection; accepted work remains Pi-owned. */
export class ConnectionMissing extends Schema.TaggedError<ConnectionMissing>()(
  "ConnectionMissing",
  {},
) {}

/** Encode failures as data across Cloudflare RPC, which does not preserve error fields. */
export const SubmissionResult = Schema.Union([Receipt, ConnectionMissing]);

export class SettingsRejected extends Schema.TaggedError<SettingsRejected>()("SettingsRejected", {
  reason: Schema.Literals(["busy", "unsupported"]),
}) {}
export const SettingsResult = Schema.Union([ChatState, SettingsRejected]);
