import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { apiRoutes } from "./api.ts";
import {
  ChatState,
  ChatUnavailable,
  ConnectionMissing,
  Receipt,
  ROOT_SESSION,
  WorkspaceRejected,
  WorkspaceState,
} from "./model.ts";
import { Conversation } from "./service.ts";

test("HTTP rejects malformed submissions and exposes only safe integration failures", async () => {
  const app = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Conversation, {
          configure: () => Effect.die("Unexpected settings request"),
          // Admission must not read/project the entire transcript as a preflight.
          read: () => Effect.die("POST must not read history"),
          workspace: Effect.die("Unexpected workspace read"),
          createSession: () => Effect.die("Unexpected creation"),
          updateSession: () => Effect.die("Unexpected update"),
          saveMemory: () => Effect.die("Unexpected memory save"),
          stop: () => Effect.die("Unexpected stop"),
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
        reason: "connection-missing",
        error: "Connect ChatGPT with bun run login:chatgpt, then restart local development.",
      }),
    );
    expect((await app.handler(new Request("http://app/api/missing"))).status).toBe(404);
  } finally {
    await app.dispose();
  }
});

test("HTTP scopes every conversation operation and validates workspace mutations", async () => {
  const calls: string[] = [];
  const chat = ChatState.make({
    messages: [],
    pending: [],
    connection: "missing",
    model: "",
    thinkingLevel: "off",
    models: [],
  });
  const workspace = WorkspaceState.make({
    sessions: [{ id: ROOT_SESSION, title: "Personal", archived: false, busy: false }],
    memory: { text: "", revision: 0 },
  });
  const app = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.succeed(Conversation, {
          read: (id) =>
            Effect.sync(() => {
              calls.push(`read:${id}`);
              return chat;
            }),
          submit: (input, id) =>
            Effect.sync(() => {
              calls.push(`submit:${id}`);
              return Receipt.make({ operationId: input.operationId, accepted: true });
            }),
          configure: (_, id) =>
            Effect.sync(() => {
              calls.push(`configure:${id}`);
              return chat;
            }),
          result: (_, id) =>
            Effect.sync(() => {
              calls.push(`result:${id}`);
              return { status: "pending" as const };
            }),
          workspace: Effect.succeed(workspace),
          createSession: () => Effect.fail(new WorkspaceRejected({ reason: "busy" })),
          updateSession: () => Effect.fail(new WorkspaceRejected({ reason: "not-found" })),
          saveMemory: () => Effect.fail(new WorkspaceRejected({ reason: "conflict" })),
          stop: (id) =>
            Effect.sync(() => {
              calls.push(`stop:${id}`);
              return chat;
            }),
        }),
      ),
    ),
    { disableLogger: true },
  );
  const request = (path: string, body?: unknown) =>
    app.handler(
      new Request(
        `http://app${path}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      ),
    );
  try {
    expect((await request("/api/chat")).status).toBe(200);
    expect((await request("/api/chat?session=2")).status).toBe(200);
    expect(
      (await request("/api/chat?session=2", { operationId: "http-scope-1", prompt: "Hello" }))
        .status,
    ).toBe(202);
    expect(
      (await request("/api/settings?session=2", { model: "gpt-6-sol", thinkingLevel: "low" }))
        .status,
    ).toBe(200);
    expect((await request("/api/operations/http-scope-1?session=2")).status).toBe(200);
    expect((await request("/api/sessions/2/stop", {})).status).toBe(200);
    expect(calls).toEqual(["read:1", "read:2", "submit:2", "configure:2", "result:2", "stop:2"]);
    for (const id of ["", "0", "-1", "1.1", "text", "9007199254740992"]) {
      expect((await request(`/api/chat?session=${id}`)).status).toBe(400);
      expect(
        (await request(`/api/chat?session=${id}`, { operationId: "http-scope-2", prompt: "Hello" }))
          .status,
      ).toBe(400);
    }
    expect(calls).toHaveLength(6);
    const conflict = await request("/api/memory", { text: "New memory", revision: 0 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ reason: "conflict" });
    expect((await request("/api/memory", { text: "x".repeat(8001), revision: 0 })).status).toBe(
      400,
    );
    expect((await request("/api/memory", { text: "test", revision: -1 })).status).toBe(400);
    expect((await request("/api/sessions/2", { title: "New name", archived: true })).status).toBe(
      404,
    );
    expect(
      (await request("/api/sessions", { title: "New", operationId: "http-create-1" })).status,
    ).toBe(409);
    expect(
      (await request("/api/sessions", { title: "x".repeat(121), operationId: "http-create-2" }))
        .status,
    ).toBe(400);
    expect((await request("/api/workspace")).status).toBe(200);
  } finally {
    await app.dispose();
  }
});
