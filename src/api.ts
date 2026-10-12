import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { HttpServerError, RequestParseError } from "effect/http/HttpServerError";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ModelSettings, OperationId, Submission } from "./model.ts";
import { Conversation } from "./service.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

const unavailable = () =>
  Effect.succeed(json({ error: "The assistant is unavailable. Reconnect and try again." }, 503));

const requestBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.stream.pipe(
    Stream.limitBytes(ByteSize.bytes(32768), () =>
      Stream.fail(
        new HttpServerError({
          reason: new RequestParseError({ request, description: "Request body exceeds 32 KiB." }),
        }),
      ),
    ),
    Stream.decodeText,
    Stream.mkString,
  );
});

/** HTTP operations shared by the native Worker and application tests. */
export const apiRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", json({ status: "ok", name: "Pi" })),
  HttpRouter.add(
    "GET",
    "/api/chat",
    Effect.gen(function* () {
      const chat = yield* Conversation;
      return json(yield* chat.read);
    }).pipe(Effect.catchTag("ChatUnavailable", unavailable)),
  ),
  HttpRouter.add(
    "POST",
    "/api/settings",
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(ModelSettings))(
        yield* requestBody,
      );
      const chat = yield* Conversation;
      return json(yield* chat.configure(input));
    }).pipe(
      Effect.catchTags({
        SettingsRejected: (error) =>
          Effect.succeed(
            json(
              {
                error:
                  error.reason === "busy"
                    ? "Wait for the current turn to finish before changing settings."
                    : "Choose a supported model and reasoning level.",
              },
              error.reason === "busy" ? 409 : 400,
            ),
          ),
        ChatUnavailable: unavailable,
      }),
      Effect.orElseSucceed(() =>
        json({ error: "Choose a supported model and reasoning level." }, 400),
      ),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/api/chat",
    Effect.gen(function* () {
      const body = yield* requestBody;
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(Submission))(body);
      const chat = yield* Conversation;
      return json(yield* chat.submit(input), 202);
    }).pipe(
      Effect.catchTags({
        ConnectionMissing: () =>
          Effect.succeed(
            json(
              {
                error:
                  "Connect ChatGPT with bun run login:chatgpt, then restart local development.",
              },
              409,
            ),
          ),
        ChatUnavailable: unavailable,
      }),
      Effect.orElseSucceed(() =>
        json({ error: "Enter a prompt of 1–8,000 characters and a valid operation ID." }, 400),
      ),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/operations/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = yield* Schema.decodeUnknownEffect(OperationId)(params.id);
      const chat = yield* Conversation;
      return json(yield* chat.result(id));
    }).pipe(
      Effect.catchTag("ChatUnavailable", unavailable),
      Effect.orElseSucceed(() => json({ error: "Invalid operation ID." }, 400)),
    ),
  ),
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
