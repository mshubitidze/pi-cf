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
  Receipt,
  SubmissionResult,
  SettingsResult,
  SettingsRejected,
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
      configure: (settings) =>
        rpc("configure", async () => await assistant.configure(settings)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SettingsResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "configure" })),
          Effect.flatMap((result) =>
            Schema.is(SettingsRejected)(result) ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
      read: rpc("read", () => assistant.read()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ChatState)),
        Effect.mapError(() => new ChatUnavailable({ operation: "read" })),
      ),
      submit: (input) =>
        rpc("submit", async () => await assistant.submit(input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SubmissionResult)),
          Effect.mapError(() => new ChatUnavailable({ operation: "submit" })),
          Effect.filterOrFail(Schema.is(Receipt), () => new ConnectionMissing()),
        ),
      result: (id) =>
        rpc("result", () => assistant.result(id)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Outcome)),
          Effect.mapError(() => new ChatUnavailable({ operation: "result" })),
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
