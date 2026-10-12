import type { AppEnv } from "./stack.ts";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { apiRoutes } from "../../api.ts";
import {
  ChatState,
  ChatUnavailable,
  ConnectionMissing,
  Outcome,
  SubmissionResult,
  SettingsResult,
  SettingsRejected,
  WorkspaceState,
  WorkspaceResult,
  WorkspaceRejected,
  SessionCreatedResult,
  StopResult,
} from "../../model.ts";
import { Conversation } from "../../service.ts";
import { authorize } from "./access.ts";

export { Assistant } from "./assistant.ts";

/** SDK errors may carry credentials. Emit only our operation identifier. */
const rpc = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: () => new ChatUnavailable({ operation }) }).pipe(
    Effect.tapError(() => Effect.logError("Assistant boundary failed", { operation })),
  );

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const denial = await Effect.runPromise(authorize(request, env));
    if (denial) {
      return denial;
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) {
        return Response.json({ error: "Invalid origin." }, { status: 403 });
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return Response.json({ error: "Expected JSON." }, { status: 415 });
      }
    }
    const assistant = env.ASSISTANT.getByName("personal");
    const conversation = Layer.succeed(Conversation, {
      configure: (settings, sessionId) =>
        rpc("configure", async () => await assistant.configure(settings, sessionId)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SettingsResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "configure" })),
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (Schema.is(SettingsRejected)(result)) return yield* result;
              if (Schema.is(WorkspaceRejected)(result)) return yield* result;
              return result;
            }),
          ),
        ),
      read: (sessionId) =>
        rpc("read", () => assistant.read(sessionId)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChatState)),
          Effect.mapError(() => new ChatUnavailable({ operation: "read" })),
        ),
      submit: (input, sessionId) =>
        rpc("submit", async () => await assistant.submit(input, sessionId)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SubmissionResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "submit" })),
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (Schema.is(ConnectionMissing)(result)) return yield* new ConnectionMissing();
              if (Schema.is(WorkspaceRejected)(result)) return yield* result;
              return result;
            }),
          ),
        ),
      result: (id, sessionId) =>
        rpc("result", () => assistant.result(id, sessionId)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Outcome)),
          Effect.mapError(() => new ChatUnavailable({ operation: "result" })),
        ),
      workspace: rpc("workspace", () => assistant.workspace()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceState)),
        Effect.mapError(() => new ChatUnavailable({ operation: "workspace" })),
      ),
      createSession: (input) =>
        rpc("createSession", async () => await assistant.createSession(input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SessionCreatedResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "createSession" })),
          Effect.flatMap((result) =>
            Schema.is(WorkspaceRejected)(result) ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
      updateSession: (id, input) =>
        rpc("updateSession", async () => await assistant.updateSession(id, input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "updateSession" })),
          Effect.flatMap((result) =>
            Schema.is(WorkspaceRejected)(result) ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
      saveMemory: (input) =>
        rpc("saveMemory", async () => await assistant.saveMemory(input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "saveMemory" })),
          Effect.flatMap((result) =>
            Schema.is(WorkspaceRejected)(result) ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
      stop: (id) =>
        rpc("stop", async () => await assistant.stop(id)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(StopResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "stop" })),
          Effect.flatMap((result) =>
            Schema.is(WorkspaceRejected)(result) ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
    });
    const { handler, dispose } = HttpRouter.toWebHandler(
      apiRoutes.pipe(Layer.provideMerge(conversation)),
      {
        disableLogger: true,
      },
    );
    try {
      return await handler(request);
    } finally {
      await dispose();
    }
  },
};
