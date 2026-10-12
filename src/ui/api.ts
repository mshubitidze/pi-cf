import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChatState, ModelSettings, OperationId, Outcome, Receipt, Submission } from "../model.ts";

/** A safe message for network, server and response-decoding failures. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  message: Schema.String,
}) {}

/** Browser-side transport capability; workflow tests provide a scripted implementation. */
export class ChatApi extends Context.Service<
  ChatApi,
  {
    readonly read: Effect.Effect<ChatState, RequestFailed>;
    readonly submit: (input: Submission) => Effect.Effect<Receipt, RequestFailed>;
    readonly result: (id: OperationId) => Effect.Effect<Outcome, RequestFailed>;
    readonly configure: (settings: ModelSettings) => Effect.Effect<ChatState, RequestFailed>;
  }
>()("pi/ui/ChatApi") {
  static readonly layer = Layer.effect(
    ChatApi,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const failure = () =>
        new RequestFailed({
          message: "Could not reach your assistant. Check the connection and retry.",
        });
      return ChatApi.of({
        configure: Effect.fn("ChatApi.configure")((settings: ModelSettings) =>
          client
            .execute(
              HttpClientRequest.post("/api/settings").pipe(
                HttpClientRequest.bodyJsonUnsafe(settings),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatState)),
              Effect.mapError(
                () =>
                  new RequestFailed({
                    message:
                      "Could not confirm settings. Refresh to check what was saved before trying again.",
                  }),
              ),
            ),
        ),
        read: client
          .get("/api/chat")
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatState)),
            Effect.mapError(failure),
          ),
        submit: Effect.fn("ChatApi.submit")((input: Submission) =>
          client
            .execute(
              HttpClientRequest.post("/api/chat").pipe(HttpClientRequest.bodyJsonUnsafe(input)),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Receipt)),
              Effect.mapError(failure),
            ),
        ),
        result: Effect.fn("ChatApi.result")((id: OperationId) =>
          client
            .get(`/api/operations/${id}`)
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Outcome)),
              Effect.mapError(failure),
            ),
        ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
