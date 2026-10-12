import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import * as Effect from "effect/Effect";
import {
  ChatState,
  ModelSettings,
  OperationId,
  Receipt,
  ROOT_SESSION,
  SessionId,
  Submission,
} from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";
import { chatMachine } from "./workflow.ts";

const unusedWorkspaceApi = {
  workspace: Effect.die("Unexpected workspace request"),
  createSession: () => Effect.die("Unexpected session creation"),
  updateSession: () => Effect.die("Unexpected session update"),
  saveMemory: () => Effect.die("Unexpected memory update"),
  stop: () => Effect.die("Unexpected stop request"),
};

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
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: SessionId.make("2"),
        requestId: OperationId.make("blocked-selection"),
      });
      expect(actor.getSnapshot().context.sessionId).toBe(ROOT_SESSION);
      yield* send(actor, { type: "RETRY", requestId: OperationId.make("retry-request-123") });
      return yield* waitFor(actor, (value) => value.matches("ready"), { timeout: "2 seconds" });
    }).pipe(
      Effect.scoped,
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
  expect(requests.map((input) => input.operationId)).toEqual([id, id]);
  expect(output.context.sessionId).toBe(ROOT_SESSION);
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
        ...unusedWorkspaceApi,
        configure: () => Effect.die("Unexpected settings request"),
        read: () =>
          Effect.sync(() =>
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
          ...unusedWorkspaceApi,
          configure: () => Effect.die("Unexpected settings request"),
          read: () =>
            Deferred.succeed(started, undefined).pipe(
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
        type: "SELECT_SESSION",
        sessionId: SessionId.make("2"),
        requestId: OperationId.make("settings-selection"),
      });
      expect(actor.getSnapshot().context.sessionId).toBe(ROOT_SESSION);
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
      expect(restored.context.sessionId).toBe(ROOT_SESSION);
      expect(saves).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.provideService(ChatApi, {
        ...unusedWorkspaceApi,
        read: () => Effect.sync(() => stored),
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

test("switching accepted work clears the transcript and ignores late results; returning observes its pending turn", async () => {
  const other = SessionId.make("2");
  const operationId = OperationId.make("accepted-first-turn");
  const reads: Array<SessionId> = [];
  const polls: Array<{ readonly operationId: OperationId; readonly sessionId: SessionId }> = [];
  const original = ChatState.make({
    messages: [{ id: "first-prompt", role: "user", text: "Original thread" }],
    pending: [operationId],
    connection: "connected",
    model: "first-model",
    thinkingLevel: "low",
    models: [],
  });
  const second = ChatState.make({
    messages: [{ id: "second-prompt", role: "user", text: "Second thread" }],
    pending: [],
    connection: "connected",
    model: "second-model",
    thinkingLevel: "high",
    models: [],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseLate = yield* Deferred.make<void>();
      const lateReturned = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const releaseResumed = yield* Deferred.make<void>();
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          configure: () => Effect.die("Unexpected settings request"),
          submit: () => Effect.die("Unexpected submission"),
          read: (sessionId) =>
            Effect.suspend(() => {
              reads.push(sessionId);
              if (sessionId === other) {
                return Deferred.await(releaseSecond).pipe(Effect.as(second));
              }
              return Effect.succeed(
                polls.length >= 2 ? ChatState.make({ ...original, pending: [] }) : original,
              );
            }),
          result: (id, sessionId) =>
            Effect.suspend(() => {
              polls.push({ operationId: id, sessionId });
              if (polls.length === 1) {
                return Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseLate)),
                  Effect.andThen(Deferred.succeed(lateReturned, undefined)),
                  Effect.as({ status: "done" } as const),
                  Effect.uninterruptible,
                );
              }
              return Deferred.succeed(resumed, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResumed)),
                Effect.as({ status: "done" } as const),
              );
            }),
        }),
      );
      yield* Deferred.await(firstStarted);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("select-second-thread"),
      });
      const loading = yield* waitFor(
        actor,
        (snapshot) => snapshot.matches("loading") && snapshot.context.sessionId === other,
      );
      expect(loading.context.chat.messages).toEqual([]);
      expect(loading.context.chat.model).toBe("");
      expect(Option.isNone(loading.context.maybeSubmission)).toBe(true);
      yield* Deferred.succeed(releaseSecond, undefined);
      const selected = yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      expect(selected.context.chat).toEqual(second);
      yield* Deferred.succeed(releaseLate, undefined);
      yield* Deferred.await(lateReturned);
      yield* Effect.yieldNow;
      expect(actor.getSnapshot().context.sessionId).toBe(other);
      expect(actor.getSnapshot().context.chat).toEqual(second);
      expect(reads).toEqual([ROOT_SESSION, other]);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: ROOT_SESSION,
        requestId: OperationId.make("return-first-thread"),
      });
      yield* Deferred.await(resumed);
      expect(actor.getSnapshot().context.chat.pending).toEqual([operationId]);
      expect(polls).toEqual([
        { operationId, sessionId: ROOT_SESSION },
        { operationId, sessionId: ROOT_SESSION },
      ]);
      yield* Deferred.succeed(releaseResumed, undefined);
      const completed = yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      expect(completed.context.sessionId).toBe(ROOT_SESSION);
      expect(completed.context.chat.model).toBe(original.model);
      expect(completed.context.chat.pending).toEqual([]);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});

test("a lost stop response blocks further writes and selection until refresh reconciles durable state", async () => {
  const operationId = OperationId.make("running-turn-to-stop");
  const original = ChatState.make({
    messages: [],
    pending: [operationId],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  let stored = original;
  const stops: Array<SessionId> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const observing = yield* Deferred.make<void>();
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          configure: () => Effect.die("Unexpected settings request"),
          submit: () => Effect.die("Stop uncertainty must block submission"),
          read: () => Effect.sync(() => stored),
          result: () => Deferred.succeed(observing, undefined).pipe(Effect.andThen(Effect.never)),
          stop: (sessionId) =>
            Effect.sync(() => {
              stops.push(sessionId);
              stored = ChatState.make({ ...original, pending: [] });
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new RequestFailed({ message: "Stop acknowledgement lost. Refresh to confirm." }),
                ),
              ),
            ),
        }),
      );
      yield* Deferred.await(observing);
      yield* send(actor, { type: "STOP", requestId: OperationId.make("stop-current-thread") });
      const uncertain = yield* waitFor(actor, (snapshot) => snapshot.matches("stopFailed"));
      expect(uncertain.context.chat.pending).toEqual([operationId]);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: SessionId.make("2"),
        requestId: OperationId.make("stop-blocked-select"),
      });
      yield* send(actor, { type: "STOP", requestId: OperationId.make("stop-blocked-repeat") });
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({
          operationId: OperationId.make("stop-blocked-submit"),
          prompt: "Wait",
        }),
      });
      yield* send(actor, {
        type: "REFRESH",
        requestId: OperationId.make("reconcile-stop-request"),
      });
      const restored = yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      expect(restored.context.sessionId).toBe(ROOT_SESSION);
      expect(restored.context.chat.pending).toEqual([]);
      expect(Option.isNone(restored.context.maybeSubmission)).toBe(true);
      expect(stops).toEqual([ROOT_SESSION]);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});

test("settings reconciliation keeps selection locked through a failed read and retry", async () => {
  const original = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "old",
    thinkingLevel: "low",
    models: [],
  });
  const saved = ChatState.make({ ...original, model: "saved" });
  let reads = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const releaseRead = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          read: () =>
            Effect.suspend(() => {
              reads++;
              if (reads === 1) {
                return Effect.succeed(original);
              }
              if (reads === 2) {
                return Effect.fail(new RequestFailed({ message: "Read failed" }));
              }
              return Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRead)),
                Effect.as(saved),
              );
            }),
          configure: () =>
            Effect.fail(new RequestFailed({ message: "Settings acknowledgement lost" })),
          submit: () => Effect.die("Reconciliation must reject submission"),
          result: () => Effect.die("No pending turn"),
        }),
      );
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      yield* send(actor, {
        type: "CONFIGURE",
        requestId: OperationId.make("uncertain-settings"),
        settings: ModelSettings.make({ model: "saved", thinkingLevel: "low" }),
      });
      yield* waitFor(actor, (snapshot) => snapshot.matches("settingsFailed"));
      yield* send(actor, {
        type: "REFRESH",
        requestId: OperationId.make("read-uncertain-settings"),
      });
      yield* waitFor(actor, (snapshot) => snapshot.matches("reconcileFailed"));
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: SessionId.make("2"),
        requestId: OperationId.make("blocked-failed-reconcile"),
      });
      yield* send(actor, { type: "RETRY", requestId: OperationId.make("retry-settings-read") });
      yield* Deferred.await(reading);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: SessionId.make("2"),
        requestId: OperationId.make("blocked-current-reconcile"),
      });
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({
          operationId: OperationId.make("blocked-reconcile-submit"),
          prompt: "Wait",
        }),
      });
      yield* Deferred.succeed(releaseRead, undefined);
      const restored = yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      expect(restored.context.sessionId).toBe(ROOT_SESSION);
      expect(restored.context.chat).toEqual(saved);
      expect(reads).toBe(3);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});

test("a definitive admission rejection preserves the prompt and permits switching while uncertain delivery stays locked", async () => {
  const other = SessionId.make("2");
  const submission = Submission.make({
    operationId: OperationId.make("rejected-archived-thread"),
    prompt: "Preserve this prompt",
  });
  const original = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          read: () => Effect.succeed(original),
          configure: () => Effect.die("Unexpected settings request"),
          result: () => Effect.die("Rejected submission must never be observed"),
          submit: () =>
            Effect.fail(
              new RequestFailed({ reason: "archived", message: "This conversation is archived." }),
            ),
        }),
      );
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      yield* send(actor, { type: "SUBMIT", submission });
      const rejected = yield* waitFor(actor, (snapshot) => snapshot.matches("submitRejected"));
      expect(Option.getOrThrow(rejected.context.maybeSubmission)).toEqual(submission);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("select-after-rejection"),
      });
      const selected = yield* waitFor(
        actor,
        (snapshot) => snapshot.matches("ready") && snapshot.context.sessionId === other,
      );
      expect(selected.context.sessionId).toBe(other);
      expect(Option.isNone(selected.context.maybeSubmission)).toBe(true);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});

test("a definitive settings rejection leaves selection available instead of requiring impossible reconciliation", async () => {
  const other = SessionId.make("2");
  const original = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          read: () => Effect.succeed(original),
          configure: () =>
            Effect.fail(
              new RequestFailed({
                reason: "not-found",
                message: "This conversation no longer exists.",
              }),
            ),
          submit: () => Effect.die("Unexpected submission"),
          result: () => Effect.die("No accepted operation"),
        }),
      );
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"));
      const requestId = OperationId.make("definitive-settings-reject");
      yield* send(actor, {
        type: "CONFIGURE",
        requestId,
        settings: ModelSettings.make({ model: "new", thinkingLevel: "high" }),
      });
      const rejected = yield* waitFor(
        actor,
        (snapshot) => snapshot.matches("ready") && Option.isSome(snapshot.context.maybeError),
      );
      expect(rejected.context.chat).toEqual(original);
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("select-after-settings-reject"),
      });
      const selected = yield* waitFor(
        actor,
        (snapshot) => snapshot.matches("ready") && snapshot.context.sessionId === other,
      );
      expect(selected.context.sessionId).toBe(other);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});

test("a definitive stop rejection permits selecting another thread", async () => {
  const other = SessionId.make("2");
  const pendingId = OperationId.make("unavailable-stop-operation");
  const empty = ChatState.make({
    messages: [],
    pending: [],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const observing = yield* Deferred.make<void>();
      const actor = yield* createEffectActor(chatMachine).pipe(
        Effect.provideService(ChatApi, {
          ...unusedWorkspaceApi,
          read: (sessionId) =>
            Effect.succeed(
              sessionId === ROOT_SESSION
                ? ChatState.make({ ...empty, pending: [pendingId] })
                : empty,
            ),
          configure: () => Effect.die("Unexpected settings request"),
          submit: () => Effect.die("Unexpected submission"),
          result: () => Deferred.succeed(observing, undefined).pipe(Effect.andThen(Effect.never)),
          stop: () =>
            Effect.fail(
              new RequestFailed({
                reason: "not-found",
                message: "This conversation no longer exists.",
              }),
            ),
        }),
      );
      yield* Deferred.await(observing);
      yield* send(actor, {
        type: "STOP",
        requestId: OperationId.make("definitive-stop-rejection"),
      });
      yield* waitFor(actor, (snapshot) => snapshot.matches("waitFailed"));
      yield* send(actor, {
        type: "SELECT_SESSION",
        sessionId: other,
        requestId: OperationId.make("select-after-stop-rejection"),
      });
      const selected = yield* waitFor(
        actor,
        (snapshot) => snapshot.matches("ready") && snapshot.context.sessionId === other,
      );
      expect(selected.context.sessionId).toBe(other);
      expect(selected.context.chat.pending).toEqual([]);
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  );
});
