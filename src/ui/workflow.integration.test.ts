import { expect, test } from "bun:test";
import { createEffectActor, waitFor } from "@xstate/effect";
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
import { ChatState, OperationId, Receipt, type Submission } from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";
import { init, Message, RetryWorkflow, SubmitPrompt, subscriptions, update } from "./main.ts";
import { ChatWorkflow, chatMachine } from "./workflow.ts";

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
        configure: () => Effect.die("Unexpected settings request"),
        read: Effect.succeed(chat),
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
      const completion = yield* SubmitPrompt({ prompt: "Hello" }).effect.pipe(
        Effect.provideService(ChatWorkflow, connected.actor),
      );
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
        configure: () => Effect.die("Unexpected settings request"),
        read: Effect.succeed(chat),
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
      const pending = yield* SubmitPrompt({ prompt: preparing.draft }).effect.pipe(
        Effect.provideService(ChatWorkflow, actor),
        Effect.forkScoped,
      );
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
        configure: () => Effect.die("Unexpected settings request"),
        read: Effect.never,
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
      const result = yield* SubmitPrompt({ prompt: "Keep me" }).effect.pipe(
        Effect.provideService(ChatWorkflow, connected.actor),
      );
      expect(result).toEqual(Message.FailedSubmitPrompt());
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChatApi, {
        configure: () => Effect.die("Unexpected settings request"),
        read: Effect.succeed(chat),
        submit: () => Effect.die("Stopped actor cannot submit"),
        result: () => Effect.die("Stopped actor cannot poll"),
      }),
    ),
  );
});
