import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ChatState,
  CreateSession,
  ModelSettings,
  OperationId,
  Outcome,
  Receipt,
  SessionCreated,
  SessionId,
  SharedMemory,
  Submission,
  UpdateSession,
  WorkspaceState,
} from "../model.ts";

const FailureReason = Schema.Literals([
  "conflict",
  "archived",
  "busy",
  "not-found",
  "unsupported",
  "connection-missing",
]);
const RejectedResponse = Schema.Struct({ reason: FailureReason });
const failureMessages = {
  conflict: "This information changed elsewhere. Reload and review it before trying again.",
  archived: "This conversation is archived. Restore it before sending a message.",
  busy: "Wait for this conversation to finish before making this change.",
  "not-found": "This conversation is unavailable. Refresh your conversations.",
  unsupported: "Choose a supported model and reasoning level.",
  "connection-missing": "Connect ChatGPT before sending a message.",
};

/** A safe message and optional known rejection reason for transport failures. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  message: Schema.String,
  reason: Schema.optional(FailureReason),
}) {}

/** Browser transport; every conversation operation explicitly names its session. */
export class ChatApi extends Context.Service<
  ChatApi,
  {
    readonly read: (sessionId: SessionId) => Effect.Effect<ChatState, RequestFailed>;
    readonly submit: (
      input: Submission,
      sessionId: SessionId,
    ) => Effect.Effect<Receipt, RequestFailed>;
    readonly result: (
      id: OperationId,
      sessionId: SessionId,
    ) => Effect.Effect<Outcome, RequestFailed>;
    readonly configure: (
      settings: ModelSettings,
      sessionId: SessionId,
    ) => Effect.Effect<ChatState, RequestFailed>;
    readonly stop: (sessionId: SessionId) => Effect.Effect<ChatState, RequestFailed>;
    readonly workspace: Effect.Effect<WorkspaceState, RequestFailed>;
    readonly createSession: (input: CreateSession) => Effect.Effect<SessionCreated, RequestFailed>;
    readonly updateSession: (
      id: SessionId,
      input: UpdateSession,
    ) => Effect.Effect<WorkspaceState, RequestFailed>;
    readonly saveMemory: (input: SharedMemory) => Effect.Effect<WorkspaceState, RequestFailed>;
  }
>()("pi/ui/ChatApi") {
  /** HTTP implementation with schema decoding and fixed rejection messages. */
  static readonly layer = Layer.effect(
    ChatApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = <A, I>(
        input: HttpClientRequest.HttpClientRequest,
        schema: Schema.Codec<A, I>,
        message = "Could not reach your assistant. Check the connection and retry.",
      ): Effect.Effect<A, RequestFailed> =>
        client.execute(input).pipe(
          Effect.flatMap((response) => {
            if (response.status >= 200 && response.status < 300) {
              return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.mapError(() => new RequestFailed({ message })),
              );
            }
            return HttpClientResponse.schemaBodyJson(RejectedResponse)(response).pipe(
              Effect.mapError(() => new RequestFailed({ message })),
              Effect.flatMap((rejection) =>
                Effect.fail(
                  new RequestFailed({
                    reason: rejection.reason,
                    message: failureMessages[rejection.reason],
                  }),
                ),
              ),
            );
          }),
          Effect.mapError((error) =>
            error instanceof RequestFailed ? error : new RequestFailed({ message }),
          ),
        );
      const sessionPath = (path: string, id: SessionId) => `${path}?session=${id}`;
      const post = (path: string, body: unknown) =>
        HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body));
      return ChatApi.of({
        configure: Effect.fn("ChatApi.configure")((settings: ModelSettings, id: SessionId) =>
          request(
            post(sessionPath("/api/settings", id), settings),
            ChatState,
            "Could not confirm settings. Refresh to check what was saved before trying again.",
          ),
        ),
        read: Effect.fn("ChatApi.read")((id: SessionId) =>
          request(HttpClientRequest.get(sessionPath("/api/chat", id)), ChatState),
        ),
        submit: Effect.fn("ChatApi.submit")((input: Submission, id: SessionId) =>
          request(post(sessionPath("/api/chat", id), input), Receipt),
        ),
        result: Effect.fn("ChatApi.result")((id: OperationId, sessionId: SessionId) =>
          request(HttpClientRequest.get(sessionPath(`/api/operations/${id}`, sessionId)), Outcome),
        ),
        stop: Effect.fn("ChatApi.stop")((id: SessionId) =>
          request(
            post(`/api/sessions/${id}/stop`, {}),
            ChatState,
            "Could not confirm the stop request. Refresh to check whether the conversation is still working.",
          ),
        ),
        workspace: request(HttpClientRequest.get("/api/workspace"), WorkspaceState),
        createSession: Effect.fn("ChatApi.createSession")((input: CreateSession) =>
          request(post("/api/sessions", input), SessionCreated),
        ),
        updateSession: Effect.fn("ChatApi.updateSession")((id: SessionId, input: UpdateSession) =>
          request(post(`/api/sessions/${id}`, input), WorkspaceState),
        ),
        saveMemory: Effect.fn("ChatApi.saveMemory")((input: SharedMemory) =>
          request(post("/api/memory", input), WorkspaceState),
        ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
