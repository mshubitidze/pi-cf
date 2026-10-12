import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import * as Effect from "effect/Effect";
import { ChatState, ModelSettings, OperationId, Receipt, Submission } from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";
import { chatMachine } from "./workflow.ts";

test("retry after a lost acknowledgement reuses the operation ID and ignores a second submission", async () => {
  const requests: Array<Submission> = [];
  const id = OperationId.make("test-operation-123");
  const chat = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine);
      yield* waitFor(actor, (value) => value.matches("ready"), { timeout: "2 seconds" });
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({ operationId: id, prompt: "hello" }),
      });
      yield* waitFor(actor, (value) => value.matches("submitFailed"), { timeout: "2 seconds" });
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({
          operationId: OperationId.make("different-operation"),
          prompt: "duplicate click",
        }),
      });
      yield* send(actor, { type: "RETRY", requestId: OperationId.make("retry-request-123") });
      return yield* waitFor(actor, (value) => value.matches("ready"), { timeout: "2 seconds" });
    }).pipe(
      Effect.scoped,
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
  expect(requests.map((input) => input.operationId)).toEqual([id, id]);
  expect(Option.isNone(output.context.maybeError)).toBe(true);
});

test("reload observes every pending operation and clears the echo when its turn settles", async () => {
  const first = OperationId.make("pending-first-123");
  const second = OperationId.make("pending-second-123");
  const observed: Array<OperationId> = [];
  const final = await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine);
      return yield* waitFor(actor, (snapshot) => snapshot.matches("ready"), {
        timeout: "2 seconds",
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChatApi, {
        configure: () => Effect.die("Unexpected settings request"),
        read: Effect.sync(() =>
          ChatState.make({
            messages: [],
            pending:
              observed.length === 0 ? [first, second] : observed.length === 1 ? [second] : [],
            connection: "connected",
            model: "test",
            thinkingLevel: "low",
            models: [],
          }),
        ),
        submit: (input) =>
          Effect.succeed(Receipt.make({ operationId: input.operationId, accepted: true })),
        result: (id) =>
          Effect.sync(() => {
            observed.push(id);
            return { status: "done" };
          }),
      }),
    ),
  );
  expect(observed).toEqual([first, second]);
  expect(Option.isNone(final.context.maybeSubmission)).toBe(true);
});

test("closing the browser actor scope interrupts observation", async () => {
  const interrupted = { value: false };
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* createEffectActor(chatMachine);
        yield* Deferred.await(started);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChatApi, {
          configure: () => Effect.die("Unexpected settings request"),
          read: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted.value = true;
              }),
            ),
          ),
          submit: (input) =>
            Effect.succeed(Receipt.make({ operationId: input.operationId, accepted: true })),
          result: () => Effect.succeed({ status: "pending" }),
        }),
      );
    }),
  );
  expect(interrupted.value).toBe(true);
});

test("an uncertain settings save blocks sending until refresh reconciles durable state", async () => {
  const original = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "gpt-6-sol",
    thinkingLevel: "low",
    models: [],
  });
  const settings = ModelSettings.make({ model: "gpt-6-astra", thinkingLevel: "high" });
  let stored = original;
  let saves = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine);
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      yield* send(actor, {
        type: "CONFIGURE",
        requestId: OperationId.make("settings-request-123"),
        settings,
      });
      const failed = yield* waitFor(actor, (snapshot) => snapshot.matches("settingsFailed"));
      expect(failed.context.chat.model).toBe(original.model);
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({
          operationId: OperationId.make("must-not-submit"),
          prompt: "Not yet",
        }),
      });
      yield* send(actor, {
        type: "CONFIGURE",
        requestId: OperationId.make("must-not-configure"),
        settings,
      });
      yield* send(actor, { type: "REFRESH", requestId: OperationId.make("reconcile-settings") });
      const restored = yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      expect(restored.context.chat).toMatchObject(settings);
      expect(saves).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(ChatApi, {
        read: Effect.sync(() => stored),
        configure: (input) =>
          Effect.sync(() => {
            saves++;
            stored = { ...original, ...input };
          }).pipe(
            Effect.andThen(
              Effect.fail(new RequestFailed({ message: "Response lost. Refresh to confirm." })),
            ),
          ),
        submit: () => Effect.die("Must not submit before reconciling settings"),
        result: () => Effect.succeed({ status: "done" }),
      }),
    ),
  );
});
