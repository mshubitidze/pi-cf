import { createEffectActor, fromEffect, setupEffect, type EffectActor } from "@xstate/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { modifyFields } from "foldkit/struct";
import {
  ChatState,
  ModelSettings,
  OperationId,
  Outcome,
  ROOT_SESSION,
  SessionId,
  Submission,
} from "../model.ts";
import { ChatApi, RequestFailed } from "./api.ts";

/** State names emitted by the workflow, projected into Foldkit's serializable Model. */
export const Phase = Schema.Literals([
  "loading",
  "ready",
  "submitting",
  "waiting",
  "loadFailed",
  "submitFailed",
  "submitRejected",
  "waitFailed",
  "configuring",
  "settingsFailed",
  "stopping",
  "stopFailed",
  "reconciling",
  "reconcileFailed",
]);
/** Browser-visible workflow projection. The actor itself lives in an Effect scope. */
export const WorkflowView = Schema.Struct({
  phase: Phase,
  sessionId: SessionId,
  chat: ChatState,
  maybeError: Schema.Option(Schema.String),
  maybeSubmission: Schema.Option(Submission),
  maybeAcknowledgedRequestId: Schema.Option(OperationId),
});
export type WorkflowView = typeof WorkflowView.Type;

/** Initial projection until the actor's first snapshot arrives. */
export const initialView = WorkflowView.make({
  phase: "loading",
  sessionId: ROOT_SESSION,
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
  sessionId: SessionId,
  chat: ChatState,
  maybeSettings: Schema.Option(ModelSettings),
  maybeSubmission: Schema.Option(Submission),
  maybeOperation: Schema.Option(OperationId),
  maybeError: Schema.Option(Schema.String),
  maybeAcknowledgedRequestId: Schema.Option(OperationId),
});
const awaitOutcome = (
  id: OperationId,
  sessionId: SessionId,
): Effect.Effect<Outcome, RequestFailed, ChatApi> =>
  Effect.gen(function* () {
    const api = yield* ChatApi;
    const result = yield* api.result(id, sessionId);
    if (result.status !== "pending") {
      return result;
    }
    yield* Effect.sleep("500 millis");
    return yield* awaitOutcome(id, sessionId);
  });

const load = fromEffect({
  schemas: { input: SessionId },
  effect: ({ input }) => ChatApi.use((api) => api.read(input)),
});
const configure = fromEffect({
  schemas: {
    input: Schema.Struct({ sessionId: SessionId, maybeSettings: Schema.Option(ModelSettings) }),
  },
  effect: ({ input }) =>
    Option.match(input.maybeSettings, {
      onNone: () => Effect.fail(new RequestFailed({ message: "No settings are available." })),
      onSome: (settings) => ChatApi.use((api) => api.configure(settings, input.sessionId)),
    }),
});
const submit = fromEffect({
  schemas: {
    input: Schema.Struct({ sessionId: SessionId, maybeSubmission: Schema.Option(Submission) }),
  },
  effect: ({ input }) =>
    Option.match(input.maybeSubmission, {
      onNone: () => Effect.fail(new RequestFailed({ message: "No submission is available." })),
      onSome: (submission) => ChatApi.use((api) => api.submit(submission, input.sessionId)),
    }),
});
const wait = fromEffect({
  schemas: {
    input: Schema.Struct({ sessionId: SessionId, maybeOperation: Schema.Option(OperationId) }),
  },
  effect: ({ input }) =>
    Option.match(input.maybeOperation, {
      onNone: () =>
        Effect.fail(new RequestFailed({ message: "No pending operation is available." })),
      onSome: (id) =>
        Effect.gen(function* () {
          const outcome = yield* awaitOutcome(id, input.sessionId);
          const api = yield* ChatApi;
          return { outcome, chat: yield* api.read(input.sessionId) };
        }),
    }),
});
const stop = fromEffect({
  schemas: { input: SessionId },
  effect: ({ input }) => ChatApi.use((api) => api.stop(input)),
});
const selectSession = ({
  context,
  event,
}: {
  context: typeof WorkflowContext.Type;
  event: { readonly sessionId: SessionId; readonly requestId: OperationId };
}) => ({
  target: "loading",
  reenter: true,
  context: modifyFields(context, {
    sessionId: () => event.sessionId,
    chat: () => initialView.chat,
    maybeSettings: () => Option.none(),
    maybeSubmission: () => Option.none(),
    maybeOperation: () => Option.none(),
    maybeError: () => Option.none(),
    maybeAcknowledgedRequestId: () => Option.some(event.requestId),
  }),
});
const stopSession = ({
  context,
  event,
}: {
  context: typeof WorkflowContext.Type;
  event: { readonly requestId: OperationId };
}) => ({
  target: "stopping",
  context: modifyFields(context, {
    maybeError: () => Option.none(),
    maybeAcknowledgedRequestId: () => Option.some(event.requestId),
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
      SELECT_SESSION: Schema.Struct({ sessionId: SessionId, requestId: OperationId }),
      STOP: Schema.Struct({ requestId: OperationId }),
    },
  },
  actors: { load, submit, wait, configure, stop },
}).createMachine({
  context: {
    sessionId: ROOT_SESSION,
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
      on: { SELECT_SESSION: selectSession },
      invoke: {
        src: "load",
        input: ({ context }) => context.sessionId,
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
    reconciling: {
      invoke: {
        src: "load",
        input: ({ context }) => context.sessionId,
        onDone: ({ context, event }) => ({
          target: event.output.pending[0] ? "waiting" : "ready",
          context: modifyFields(context, {
            chat: () => event.output,
            maybeOperation: () => Option.fromUndefinedOr(event.output.pending[0]),
            maybeError: () => Option.none(),
          }),
        }),
        onError: ({ context, event }) => ({
          target: "reconcileFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    reconcileFailed: {
      on: {
        RETRY: ({ context, event }) => ({
          target: "reconciling",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
        REFRESH: ({ context, event }) => ({
          target: "reconciling",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    ready: {
      on: {
        SELECT_SESSION: selectSession,
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
        input: ({ context }) => ({
          sessionId: context.sessionId,
          maybeSettings: context.maybeSettings,
        }),
        onDone: ({ context, event }) => ({
          target: event.output.pending[0] ? "waiting" : "ready",
          context: modifyFields(context, {
            chat: () => event.output,
            maybeSettings: () => Option.none(),
            maybeOperation: () => Option.fromUndefinedOr(event.output.pending[0]),
          }),
        }),
        onError: ({ context, event }) => ({
          target: event.error.reason ? "ready" : "settingsFailed",
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
          target: "reconciling",
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
        input: ({ context }) => ({
          sessionId: context.sessionId,
          maybeSubmission: context.maybeSubmission,
        }),
        onDone: { target: "waiting" },
        onError: ({ context, event }) => ({
          target: event.error.reason ? "submitRejected" : "submitFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    waiting: {
      on: { SELECT_SESSION: selectSession, STOP: stopSession },
      invoke: {
        src: "wait",
        input: ({ context }) => ({
          sessionId: context.sessionId,
          maybeOperation: context.maybeOperation,
        }),
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
    stopping: {
      invoke: {
        src: "stop",
        input: ({ context }) => context.sessionId,
        onDone: ({ context, event }) => ({
          target: event.output.pending[0] ? "waiting" : "ready",
          context: modifyFields(context, {
            chat: () => event.output,
            maybeSubmission: () => Option.none(),
            maybeOperation: () => Option.fromUndefinedOr(event.output.pending[0]),
            maybeError: () => Option.none(),
          }),
        }),
        onError: ({ context, event }) => ({
          target: event.error.reason ? "waitFailed" : "stopFailed",
          context: modifyFields(context, { maybeError: () => Option.some(event.error.message) }),
        }),
      },
    },
    stopFailed: {
      on: {
        REFRESH: ({ context, event }) => ({
          target: "reconciling",
          context: modifyFields(context, {
            maybeSubmission: () => Option.none(),
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    loadFailed: {
      on: {
        SELECT_SESSION: selectSession,
        RETRY: ({ context, event }) => ({
          target: "loading",
          context: modifyFields(context, {
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
      },
    },
    submitRejected: {
      on: {
        SELECT_SESSION: selectSession,
        REFRESH: ({ context, event }) => ({
          target: "loading",
          context: modifyFields(context, {
            maybeSubmission: () => Option.none(),
            maybeOperation: () => Option.none(),
            maybeAcknowledgedRequestId: () => Option.some(event.requestId),
            maybeError: () => Option.none(),
          }),
        }),
        RETRY: ({ context, event }) => ({
          target: "submitting",
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
        SELECT_SESSION: selectSession,
        STOP: stopSession,
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
    sessionId: snapshot.context.sessionId,
    chat: snapshot.context.chat,
    maybeError: snapshot.context.maybeError,
    maybeSubmission: snapshot.context.maybeSubmission,
    maybeAcknowledgedRequestId: snapshot.context.maybeAcknowledgedRequestId,
  });
