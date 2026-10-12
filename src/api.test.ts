import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { apiRoutes } from "./api.ts";
import { ChatUnavailable, ConnectionMissing, Receipt } from "./model.ts";
import { Conversation } from "./service.ts";

test("HTTP rejects malformed submissions and exposes only safe integration failures", async () => {
  const app = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Conversation, {
          configure: () => Effect.die("Unexpected settings request"),
          // Admission must not read/project the entire transcript as a preflight.
          read: Effect.die("POST must not read history"),
          submit: (input) =>
            input.prompt === "fail"
              ? Effect.fail(new ChatUnavailable({ operation: "submit" }))
              : input.prompt === "disconnected"
                ? Effect.fail(new ConnectionMissing())
                : Effect.succeed(Receipt.make({ operationId: input.operationId, accepted: true })),
          result: () => Effect.succeed({ status: "pending" }),
        }),
      ),
    ),
    { disableLogger: true },
  );
  const post = (body: unknown) =>
    app.handler(
      new Request("http://app/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    expect((await post({ operationId: "valid-id-123", prompt: "   " })).status).toBe(400);
    expect((await post({ operationId: "valid-id-123", prompt: "x".repeat(8001) })).status).toBe(
      400,
    );
    expect((await post({ operationId: "bad", prompt: "hello" })).status).toBe(400);
    const oversizedBody = await app.handler(
      new Request("http://app/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(40_000) + JSON.stringify({ operationId: "valid-id-123", prompt: "hello" }),
      }),
    );
    expect(oversizedBody.status).toBe(400);
    const accepted = await post({ operationId: "valid-id-123", prompt: "hello" });
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe(
      JSON.stringify({ operationId: "valid-id-123", accepted: true }),
    );
    const failure = await post({ operationId: "valid-id-456", prompt: "fail" });
    expect(failure.status).toBe(503);
    expect(await failure.text()).toBe(
      JSON.stringify({ error: "The assistant is unavailable. Reconnect and try again." }),
    );
    const disconnected = await post({ operationId: "valid-id-789", prompt: "disconnected" });
    expect(disconnected.status).toBe(409);
    expect(await disconnected.text()).toBe(
      JSON.stringify({
        error: "Connect ChatGPT with bun run login:chatgpt, then restart local development.",
      }),
    );
    expect((await app.handler(new Request("http://app/api/missing"))).status).toBe(404);
  } finally {
    await app.dispose();
  }
});
