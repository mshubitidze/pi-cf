import { createEffectActor, fromEffect, setupEffect, type EffectActor } from "@xstate/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { modifyFields } from "foldkit/struct";
import { ChatState, ModelSettings, OperationId, Outcome, Submission } from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";

/** State names emitted by the workflow, projected into Foldkit's serializable Model. */
export const Phase = Schema.Literals([
  "loading",
  "ready",
  "submitting",
  "waiting",
  "loadFailed",
  "submitFailed",
  "waitFailed",
  "configuring",
  "settingsFailed",
]);
/** Browser-visible workflow projection. The actor itself lives in an Effect scope. */
export const WorkflowView = Schema.Struct({
  phase: Phase,
  chat: ChatState,
  maybeError: Schema.Option(Schema.String),
  maybeSubmission: Schema.Option(Submission),
  maybeAcknowledgedRequestId: Schema.Option(OperationId),
});
export type WorkflowView = typeof WorkflowView.Type;

/** Initial projection until the actor's first snapshot arrives. */
export const initialView = WorkflowView.make({
  phase: "loading",
  chat: ChatState.make({
    messages: [],
    pending: [],
    connection: "missing",
    model: "",
    thinkingLevel: "off",
    models: [],
  }),
  maybeError: Option.none(),
  maybeSubmission: Option.none(),
  maybeAcknowledgedRequestId: Option.none(),
});

const WorkflowContext = Schema.Struct({
  chat: ChatState,
  maybeSettings: Schema.Option(ModelSettings),
  maybeSubmission: Schema.Option(Submission),
  maybeOperation: Schema.Option(OperationId),
  maybeError: Schema.Option(Schema.String),
  maybeAcknowledgedRequestId: Schema.Option(OperationId),
});
const awaitOutcome = (id: OperationId): Effect.Effect<Outcome, RequestFailed, ChatApi> =>
  Effect.gen(function* () {
    const api = yield* ChatApi;
    const result = yield* api.result(id);
    if (result.status !== "pending") {
      return result;
    }
    yield* Effect.sleep("500 millis");
    return yield* awaitOutcome(id);
  });

const load = fromEffect(ChatApi.use((api) => api.read));
const configure = fromEffect({
  schemas: { input: Schema.Option(ModelSettings) },
  effect: ({ input }) =>
    Option.match(input, {
      onNone: () => Effect.fail(new RequestFailed({ message: "No settings are available." })),
      onSome: (settings) => ChatApi.use((api) => api.configure(settings)),
    }),
});
const submit = fromEffect({
  schemas: { input: Schema.Option(Submission) },
  effect: ({ input }) =>
    Option.match(input, {
      onNone: () => Effect.fail(new RequestFailed({ message: "No submission is available." })),
      onSome: (submission) => ChatApi.use((api) => api.submit(submission)),
    }),
});
const wait = fromEffect({
  schemas: { input: Schema.Option(OperationId) },
  effect: ({ input }) =>
    Option.match(input, {
      onNone: () =>
        Effect.fail(new RequestFailed({ message: "No pending operation is available." })),
      onSome: (id) =>
        Effect.gen(function* () {
          const outcome = yield* awaitOutcome(id);
          const api = yield* ChatApi;
          return { outcome, chat: yield* api.read };
        }),
    }),
});

/** XState owns submission and recovery; Pi owns the accepted operation's execution. */
export const chatMachine = setupEffect({
  schemas: {
    context: WorkflowContext,
    events: {
      SUBMIT: Schema.Struct({ submission: Submission }),
      RETRY: Schema.Struct({ requestId: OperationId }),
      REFRESH: Schema.Struct({ requestId: OperationId }),
      CONFIGURE: Schema.Struct({ requestId: OperationId, settings: ModelSettings }),
    },
  },
  actors: { load, submit, wait, configure },
}).createMachine({
  context: {
    chat: initialView.chat,
    maybeSettings: Option.none(),
    maybeSubmission: Option.none(),
    maybeOperation: Option.none(),
    maybeError: Option.none(),
    maybeAcknowledgedRequestId: Option.none(),
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        onDone: ({ context, event }) => ({
          target: event.output.pending[0] ? "waiting" : "ready",
          context: modifyFields(context, {
            chat: () => event.output,
            maybeOperation: () => Option.fromUndefinedOr(event.output.pending[0]),
            maybeError: () => Option.none(),
          }),
        }),
        onError: ({ context, event }) => ({
          target: "loadFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    ready: {
      on: {
        CONFIGURE: ({ context, event }) => ({
          target: "configuring",
          context: modifyFields(context, {
            maybeSettings: () => Option.some(event.settings),
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
        SUBMIT: ({ context, event }) => ({
          target: "submitting",
          context: modifyFields(context, {
            maybeSubmission: () => Option.some(event.submission),
            maybeAcknowledgedRequestId: () => Option.some(event.submission.operationId),
            maybeOperation: () => Option.some(event.submission.operationId),
            maybeError: () => Option.none(),
          }),
        }),
        REFRESH: ({ context, event }) => ({
          target: "loading",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
          }),
        }),
      },
    },
    configuring: {
      invoke: {
        src: "configure",
        input: ({ context }) => context.maybeSettings,
        onDone: ({ context, event }) => ({
          target: event.output.pending[0] ? "waiting" : "ready",
          context: modifyFields(context, {
            chat: () => event.output,
            maybeSettings: () => Option.none(),
            maybeOperation: () => Option.fromUndefinedOr(event.output.pending[0]),
          }),
        }),
        onError: ({ context, event }) => ({
          target: "settingsFailed",
          context: modifyFields(context, {
            maybeSettings: () => Option.none(),
            maybeError: () => Option.some(event.error.message),
          }),
        }),
      },
    },
    settingsFailed: {
      on: {
        REFRESH: ({ context, event }) => ({
          target: "loading",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => context.maybeSubmission,
        onDone: { target: "waiting" },
        onError: ({ context, event }) => ({
          target: "submitFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    waiting: {
      invoke: {
        src: "wait",
        input: ({ context }) => context.maybeOperation,
        onDone: ({ context, event }) => ({
          target: event.output.chat.pending[0] ? "waiting" : "ready",
          reenter: true,
          context: modifyFields(context, {
            chat: () => event.output.chat,
            maybeSubmission: () => Option.none(),
            maybeOperation: () => Option.fromUndefinedOr(event.output.chat.pending[0]),
            maybeError: () =>
              event.output.outcome.status === "unanswered"
                ? Option.some(
                    "No answer was produced. Check your ChatGPT connection and model access, then send a new message.",
                  )
                : Option.none(),
          }),
        }),
        onError: ({ context, event }) => ({
          target: "waitFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    loadFailed: {
      on: {
        RETRY: ({ context, event }) => ({
          target: "loading",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    submitFailed: {
      on: {
        RETRY: ({ context, event }) => ({
          target: "submitting",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    waitFailed: {
      on: {
        RETRY: ({ context, event }) => ({
          target: "waiting",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
  },
});

/** One workflow actor per browser application, automatically stopped when its scope closes. */
export class ChatWorkflow extends Context.Service<ChatWorkflow, EffectActor<typeof chatMachine>>()(
  "pi/ui/ChatWorkflow",
) {
  static readonly layer = Layer.effect(ChatWorkflow, createEffectActor(chatMachine)).pipe(
    Layer.provide(ChatApi.layer),
  );
}

/** Keep the browser projection small and serializable. */
export const toWorkflowView = (snapshot: {
  value: typeof Phase.Type;
  context: typeof WorkflowContext.Type;
}): WorkflowView =>
  WorkflowView.make({
    phase: snapshot.value,
    chat: snapshot.context.chat,
    maybeError: snapshot.context.maybeError,
    maybeSubmission: snapshot.context.maybeSubmission,
    maybeAcknowledgedRequestId: snapshot.context.maybeAcknowledgedRequestId,
  });
