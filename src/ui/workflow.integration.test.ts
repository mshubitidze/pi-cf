import { expect, test } from "bun:test";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { modifyFields } from "foldkit/struct";
import {
  ChatState,
  OperationId,
  Receipt,
  ROOT_SESSION,
  SessionId,
  type Submission,
} from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";
import { init, Message, RetryWorkflow, SubmitPrompt, subscriptions, update } from "./main.ts";
import { ChatWorkflow, chatMachine } from "./workflow.ts";

const unusedWorkspaceApi = {
  workspace: Effect.die("Unexpected workspace request"),
  createSession: () => Effect.die("Unexpected session creation"),
  updateSession: () => Effect.die("Unexpected session update"),
  saveMemory: () => Effect.die("Unexpected memory update"),
  stop: () => Effect.die("Unexpected stop request"),
};

const chat = ChatState.make({
  messages: [],
  pending: [],
  connection: "connected",
  model: "test",
  thinkingLevel: "low",
  models: [],
});
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const connect = Effect.gen(function* () {
  const actor = yield* createEffectActor(chatMachine);
  const messages = yield* Queue.unbounded<Message>();
  yield* subscriptions.workflow.dependenciesToStream({}).pipe(
    Stream.runForEach((message) => Queue.offer(messages, message)),
    Effect.provideService(ChatWorkflow, actor),
    Effect.forkScoped,
  );
  const nextPhase = (phase: string) =>
    Stream.fromQueue(messages).pipe(
      Stream.filter(
        (message) => message._tag === "UpdatedWorkflow" && message.workflow.phase === phase,
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((messages) => Option.getOrThrow(Array.head(messages))),
    );
  const ready = yield* nextPhase("ready");
  return { actor, nextPhase, model: update(init().model, ready).model };
});

test("real command waits for UUID and actor acknowledgement; immediate completion reconciles in either delivery order", async () => {
  const requests: Array<Submission> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const connected = yield* connect;
      const releaseId = yield* Deferred.make<void>();
      const generating = yield* Deferred.make<void>();
      const draft = update(connected.model, Message.UpdatedDraft({ value: "Hello" })).model;
      const preparing = update(draft, Message.SubmittedPrompt());
      const command = Option.getOrThrow(Array.head(preparing.commands ?? []));
      const pending = yield* command.effect.pipe(
        Effect.provideService(ChatWorkflow, connected.actor),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Deferred.succeed(generating, undefined).pipe(
            Effect.andThen(Deferred.await(releaseId)),
            Effect.as("11111111-1111-4111-8111-111111111111"),
          ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(generating);
      expect(requests).toHaveLength(0);
      expect(update(preparing.model, Message.ClickedRefresh()).model).toEqual(preparing.model);
      expect(update(preparing.model, Message.SubmittedPrompt()).commands).toBeUndefined();
      yield* Deferred.succeed(releaseId, undefined);
      const completed = yield* Fiber.join(pending);
      expect(completed._tag).toBe("CompletedSubmitPrompt");
      yield* waitFor(connected.actor, (snapshot) => snapshot.matches("ready"));
      const projected = yield* connected.nextPhase("ready");
      const completionFirst = update(preparing.model, completed).model;
      expect(completionFirst.dispatch._tag).toBe("AwaitingSnapshot");
      const first = update(completionFirst, projected).model;
      const second = update(update(preparing.model, projected).model, completed).model;
      expect(first).toEqual(second);
      expect(first.dispatch._tag).toBe("Idle");
      expect(first.draft).toBe("");
      expect(requests).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        configure: () => Effect.die("Unexpected settings request"),
        read: () => Effect.succeed(chat),
        submit: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return Receipt.make({ operationId: input.operationId, accepted: true });
          }),
        result: () => Effect.succeed({ status: "done" }),
      }),
    ),
  );
});

test("real retry command uses a new acknowledgement ID but resubmits the original durable operation", async () => {
  const requests: Array<Submission> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const connected = yield* connect;
      const draft = update(connected.model, Message.UpdatedDraft({ value: "Hello" })).model;
      const preparing = update(draft, Message.SubmittedPrompt()).model;
      const completion = yield* SubmitPrompt({
        prompt: "Hello",
        sessionId: ROOT_SESSION,
      }).effect.pipe(Effect.provideService(ChatWorkflow, connected.actor));
      const failed = update(
        update(preparing, completion).model,
        yield* connected.nextPhase("submitFailed"),
      ).model;
      expect(failed.dispatch._tag).toBe("Idle");
      const retrying = update(failed, Message.ClickedRetry()).model;
      expect(update(retrying, Message.SubmittedPrompt()).commands).toBeUndefined();
      const retried = yield* RetryWorkflow().effect.pipe(
        Effect.provideService(ChatWorkflow, connected.actor),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Effect.succeed("22222222-2222-4222-8222-222222222222"),
        }),
      );
      expect(retried).toEqual(
        Message.CompletedRetryWorkflow({
          requestId: OperationId.make("22222222-2222-4222-8222-222222222222"),
        }),
      );
      const final = update(
        update(retrying, retried).model,
        yield* connected.nextPhase("ready"),
      ).model;
      expect(final.dispatch._tag).toBe("Idle");
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        configure: () => Effect.die("Unexpected settings request"),
        read: () => Effect.succeed(chat),
        submit: (input) =>
          Effect.suspend(() => {
            requests.push(input);
            return requests.length === 1
              ? Effect.fail(new RequestFailed({ message: "Acknowledgement lost" }))
              : Effect.succeed(Receipt.make({ operationId: input.operationId, accepted: false }));
          }),
        result: () => Effect.succeed({ status: "done" }),
      }),
    ),
  );
});

test("a rejected intention times out without clearing the draft or leaving dispatch locked", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine);
      const ready = modifyFields(init().model, {
        draft: () => "Keep me",
        workflow: (workflow) => modifyFields(workflow, { phase: () => "ready", chat: () => chat }),
      });
      const preparing = update(ready, Message.SubmittedPrompt()).model;
      const pending = yield* SubmitPrompt({
        prompt: preparing.draft,
        sessionId: ROOT_SESSION,
      }).effect.pipe(Effect.provideService(ChatWorkflow, actor), Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      const failed = yield* Fiber.join(pending);
      expect(failed).toEqual(Message.FailedSubmitPrompt());
      expect(preparing.dispatch._tag).toBe("Preparing");
      const recovered = update(preparing, failed).model;
      expect(recovered.draft).toBe("Keep me");
      expect(recovered.dispatch._tag).toBe("Idle");
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        configure: () => Effect.die("Unexpected settings request"),
        read: () => Effect.never,
        submit: () => Effect.die("Loading actor must reject submission"),
        result: () => Effect.die("Loading actor cannot poll"),
      }),
    ),
  );
});

test("a stopped actor reports command failure instead of leaving preparation pending", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const connected = yield* connect;
      yield* Effect.sync(() => connected.actor.stop());
      const result = yield* SubmitPrompt({
        prompt: "Keep me",
        sessionId: ROOT_SESSION,
      }).effect.pipe(Effect.provideService(ChatWorkflow, connected.actor));
      expect(result).toEqual(Message.FailedSubmitPrompt());
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        configure: () => Effect.die("Unexpected settings request"),
        read: () => Effect.succeed(chat),
        submit: () => Effect.die("Stopped actor cannot submit"),
        result: () => Effect.die("Stopped actor cannot poll"),
      }),
    ),
  );
});

test("a real command completion from the former thread preserves the selected thread's draft, settings and dispatch", async () => {
  const other = SessionId.make("2");
  const second = ChatState.make({
    ...chat,
    model: "second-model",
    thinkingLevel: "high",
    messages: [{ id: "second-message", role: "user", text: "Other conversation" }],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const connected = yield* connect;
      const completion = yield* SubmitPrompt({
        prompt: "First conversation",
        sessionId: ROOT_SESSION,
      }).effect.pipe(Effect.provideService(ChatWorkflow, connected.actor));
      yield* waitFor(connected.actor, (snapshot) => snapshot.matches("waiting"));
      yield* send(connected.actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("switch-before-completion"),
      });
      yield* waitFor(
        connected.actor,
        (snapshot) => snapshot.matches("ready") && snapshot.context.sessionId === other,
      );
      const switched = update(connected.model, yield* connected.nextPhase("ready")).model;
      const composing = update(
        switched,
        Message.UpdatedDraft({ value: "Keep second draft" }),
      ).model;
      const late = update(composing, completion).model;
      expect(late.draft).toBe("Keep second draft");
      expect(late.workflow.sessionId).toBe(other);
      expect(late.workflow.chat).toEqual(second);
      expect(late.dispatch).toEqual(composing.dispatch);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        read: (sessionId) => Effect.succeed(sessionId === other ? second : chat),
        configure: () => Effect.die("Unexpected settings request"),
        submit: (input) =>
          Effect.succeed(Receipt.make({ operationId: input.operationId, accepted: true })),
        result: () => Effect.never,
      }),
    ),
  );
});

test("HTTP adapter scopes requests to the session and displays only known rejection messages", async () => {
  const other = SessionId.make("2");
  const id = OperationId.make("adapter-turn-operation");
  const paths: Array<string> = [];
  let memoryRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === "/api/memory") {
        memoryRequests++;
        return Response.json(
          memoryRequests === 1
            ? { reason: "conflict", error: "private provider details" }
            : { error: "private provider details" },
          { status: 409 },
        );
      }
      if (url.pathname.startsWith("/api/operations/")) {
        return Response.json({ status: "done" });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        return Response.json({ operationId: id, accepted: true }, { status: 202 });
      }
      return Response.json(chat);
    },
  });
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: server.url.origin, pathname: "/" },
  });
  try {
    const failures = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ChatApi;
        yield* api.read(other);
        yield* api.submit({ operationId: id, prompt: "hello" }, other);
        yield* api.result(id, other);
        yield* api.configure({ model: "test", thinkingLevel: "low" }, other);
        yield* api.stop(other);
        const conflict = yield* api.saveMemory({ text: "memory", revision: 0 }).pipe(Effect.flip);
        const unknown = yield* api.saveMemory({ text: "memory", revision: 0 }).pipe(Effect.flip);
        return { conflict, unknown };
      }).pipe(Effect.provide(ChatApi.layer)),
    );
    expect(paths).toEqual([
      "/api/chat?session=2",
      "/api/chat?session=2",
      `/api/operations/${id}?session=2`,
      "/api/settings?session=2",
      "/api/sessions/2/stop",
      "/api/memory",
      "/api/memory",
    ]);
    expect(failures.conflict.reason).toBe("conflict");
    expect(failures.conflict.message).toBe(
      "This information changed elsewhere. Reload and review it before trying again.",
    );
    expect(failures.unknown.reason).toBeUndefined();
    expect(failures.unknown.message).toBe(
      "Could not reach your assistant. Check the connection and retry.",
    );
    expect(JSON.stringify(failures)).not.toContain("private provider details");
  } finally {
    server.stop(true);
    if (previousLocation) {
      Object.defineProperty(globalThis, "location", previousLocation);
    } else {
      Reflect.deleteProperty(globalThis, "location");
    }
  }
});

test("definitive rejection restores the draft in both acknowledgement orders and permits switching without resubmission", async () => {
  const other = SessionId.make("2");
  const deliveries: Array<Submission> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const connected = yield* connect;
      const drafted = update(
        connected.model,
        Message.UpdatedDraft({ value: "Keep rejected prompt" }),
      ).model;
      const preparing = update(drafted, Message.SubmittedPrompt()).model;
      const completed = yield* SubmitPrompt({
        prompt: "Keep rejected prompt",
        sessionId: ROOT_SESSION,
      }).effect.pipe(Effect.provideService(ChatWorkflow, connected.actor));
      yield* waitFor(connected.actor, (snapshot) => snapshot.matches("submitRejected"));
      const projected = yield* connected.nextPhase("submitRejected");
      const completionFirst = update(update(preparing, completed).model, projected).model;
      const snapshotFirst = update(update(preparing, projected).model, completed).model;
      expect(completionFirst.draft).toBe("Keep rejected prompt");
      expect(snapshotFirst.draft).toBe("Keep rejected prompt");
      expect(completionFirst.dispatch._tag).toBe("Idle");
      expect(snapshotFirst.dispatch._tag).toBe("Idle");
      yield* send(connected.actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("switch-rejected-admission"),
      });
      yield* waitFor(
        connected.actor,
        (snapshot) => snapshot.matches("ready") && snapshot.context.sessionId === other,
      );
      const selected = update(snapshotFirst, yield* connected.nextPhase("ready")).model;
      expect(selected.workflow.sessionId).toBe(other);
      expect(selected.drafts[ROOT_SESSION]).toBe("Keep rejected prompt");
      expect(selected.draft).toBe("");
      expect(deliveries).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        read: () => Effect.succeed(chat),
        configure: () => Effect.die("Unexpected settings request"),
        submit: (input) =>
          Effect.sync(() => deliveries.push(input)).pipe(
            Effect.andThen(
              Effect.fail(
                new RequestFailed({
                  reason: "archived",
                  message: "Restore this conversation before sending.",
                }),
              ),
            ),
          ),
        result: () => Effect.die("Rejected prompt cannot start observation"),
      }),
    ),
  );
});
