import * as Schema from "effect/Schema";

/** An idempotency key that identifies one submitted turn. */
export const OperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{8,80}$/)).pipe(
  Schema.brand("OperationId"),
);
export type OperationId = typeof OperationId.Type;

/** Pi owns conversation identifiers; the existing root remains "1". */
export const SessionId = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,15}$/),
  Schema.makeFilter((value: string) => Number.isSafeInteger(Number(value))),
).pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;
export const ROOT_SESSION = SessionId.make("1");

export const MAX_MEMORY_LENGTH = 8000;
export const SessionSummary = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  archived: Schema.Boolean,
  busy: Schema.Boolean,
});
export type SessionSummary = typeof SessionSummary.Type;
export const SharedMemory = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(MAX_MEMORY_LENGTH)),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type SharedMemory = typeof SharedMemory.Type;
export const WorkspaceState = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
  memory: SharedMemory,
});
export type WorkspaceState = typeof WorkspaceState.Type;
export const CreateSession = Schema.Struct({
  operationId: OperationId,
  title: Schema.String.check(Schema.isMaxLength(120)),
  forkFrom: Schema.optional(SessionId),
});
export type CreateSession = typeof CreateSession.Type;
export const SessionCreated = Schema.Struct({ sessionId: SessionId, workspace: WorkspaceState });
export type SessionCreated = typeof SessionCreated.Type;
export const UpdateSession = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(120),
    Schema.isPattern(/\S/),
  ),
  archived: Schema.Boolean,
});
export type UpdateSession = typeof UpdateSession.Type;

export class WorkspaceRejected extends Schema.TaggedError<WorkspaceRejected>()(
  "WorkspaceRejected",
  {
    reason: Schema.Literals(["conflict", "busy", "not-found", "archived"]),
  },
) {}
export const WorkspaceResult = Schema.Union([WorkspaceState, WorkspaceRejected]);
export const SessionCreatedResult = Schema.Union([SessionCreated, WorkspaceRejected]);

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
export const StopResult = Schema.Union([ChatState, WorkspaceRejected]);

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
export const SubmissionResult = Schema.Union([Receipt, ConnectionMissing, WorkspaceRejected]);

export class SettingsRejected extends Schema.TaggedError<SettingsRejected>()("SettingsRejected", {
  reason: Schema.Literals(["busy", "unsupported"]),
}) {}
export const SettingsResult = Schema.Union([ChatState, SettingsRejected, WorkspaceRejected]);
