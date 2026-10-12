import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { HttpServerError, RequestParseError } from "effect/http/HttpServerError";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  CreateSession,
  ModelSettings,
  OperationId,
  ROOT_SESSION,
  SessionId,
  SharedMemory,
  Submission,
  UpdateSession,
  type WorkspaceRejected,
} from "./model.ts";
import { Conversation } from "./service.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

const unavailable = () =>
  Effect.succeed(json({ error: "The assistant is unavailable. Reconnect and try again." }, 503));

const workspaceRejected = (error: WorkspaceRejected) => {
  const messages = {
    conflict: "The saved state conflicts with this request. Refresh before trying again.",
    busy: "Wait for this conversation to finish before changing it.",
    "not-found": "This conversation is not available.",
    archived: "Restore this archived conversation before sending another message.",
  };
  return Effect.succeed(
    json(
      { error: messages[error.reason], reason: error.reason },
      error.reason === "not-found" ? 404 : 409,
    ),
  );
};

/** Omitted session selects the original conversation, preserving existing clients. */
const selectedSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* Schema.decodeEffect(SessionId)(
    new URL(request.url, "http://internal").searchParams.get("session") ?? ROOT_SESSION,
  );
});
const pathSession = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  return yield* Schema.decodeUnknownEffect(SessionId)(params.id);
});

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
      return json(yield* chat.read(yield* selectedSession));
    }).pipe(
      Effect.catchTag("ChatUnavailable", unavailable),
      Effect.orElseSucceed(() => json({ error: "Invalid conversation." }, 400)),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/api/settings",
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(ModelSettings))(
        yield* requestBody,
      );
      const chat = yield* Conversation;
      return json(yield* chat.configure(input, yield* selectedSession));
    }).pipe(
      Effect.catchTags({
        SettingsRejected: (error) =>
          Effect.succeed(
            json(
              {
                reason: error.reason,
                error:
                  error.reason === "busy"
                    ? "Wait for the current turn to finish before changing settings."
                    : "Choose a supported model and reasoning level.",
              },
              error.reason === "busy" ? 409 : 400,
            ),
          ),
        ChatUnavailable: unavailable,
        WorkspaceRejected: workspaceRejected,
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
      return json(yield* chat.submit(input, yield* selectedSession), 202);
    }).pipe(
      Effect.catchTags({
        ConnectionMissing: () =>
          Effect.succeed(
            json(
              {
                reason: "connection-missing",
                error:
                  "Connect ChatGPT with bun run login:chatgpt, then restart local development.",
              },
              409,
            ),
          ),
        ChatUnavailable: unavailable,
        WorkspaceRejected: workspaceRejected,
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
      return json(yield* chat.result(id, yield* selectedSession));
    }).pipe(
      Effect.catchTag("ChatUnavailable", unavailable),
      Effect.orElseSucceed(() => json({ error: "Invalid operation ID." }, 400)),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/workspace",
    Effect.gen(function* () {
      return json(yield* (yield* Conversation).workspace);
    }).pipe(Effect.catchTag("ChatUnavailable", unavailable)),
  ),
  HttpRouter.add(
    "POST",
    "/api/sessions",
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(CreateSession))(
        yield* requestBody,
      );
      return json(yield* (yield* Conversation).createSession(input), 201);
    }).pipe(
      Effect.catchTags({ ChatUnavailable: unavailable, WorkspaceRejected: workspaceRejected }),
      Effect.orElseSucceed(() =>
        json({ error: "Enter a valid conversation title and operation ID." }, 400),
      ),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/api/sessions/:id",
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(UpdateSession))(
        yield* requestBody,
      );
      return json(yield* (yield* Conversation).updateSession(yield* pathSession, input));
    }).pipe(
      Effect.catchTags({ ChatUnavailable: unavailable, WorkspaceRejected: workspaceRejected }),
      Effect.orElseSucceed(() =>
        json({ error: "Enter a conversation title of 1–120 characters." }, 400),
      ),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/api/sessions/:id/stop",
    Effect.gen(function* () {
      // Enforce the same bounded JSON body contract as other writes.
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({})))(yield* requestBody);
      return json(yield* (yield* Conversation).stop(yield* pathSession));
    }).pipe(
      Effect.catchTags({ ChatUnavailable: unavailable, WorkspaceRejected: workspaceRejected }),
      Effect.orElseSucceed(() => json({ error: "Invalid stop request." }, 400)),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/api/memory",
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Schema.fromJsonString(SharedMemory))(
        yield* requestBody,
      );
      return json(yield* (yield* Conversation).saveMemory(input));
    }).pipe(
      Effect.catchTags({ ChatUnavailable: unavailable, WorkspaceRejected: workspaceRejected }),
      Effect.orElseSucceed(() =>
        json({ error: "Memory must be at most 8,000 characters with a valid revision." }, 400),
      ),
    ),
  ),
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
