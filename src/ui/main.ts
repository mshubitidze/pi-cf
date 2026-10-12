import * as Record from "effect/Record";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { send, snapshots, waitFor } from "@xstate/effect";
import { Command, Dom, Subscription } from "foldkit";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import * as Update from "foldkit/update";
import * as Combobox from "./components/ui/combobox.ts";
import * as Dialog from "./components/ui/dialog.ts";
import {
  LoadWorkspace,
  ReadSelectedThread,
  RememberSelectedThread,
  SelectSession,
  workspaceHandlers,
} from "./workspace.ts";
import { closeThreadPopover, closeWorkspacePopover, closeSettingsPopover } from "./overlays.ts";
import * as Popover from "./components/ui/popover.ts";
import { ModelSettings, OperationId, Submission, SessionId, ROOT_SESSION } from "../model.ts";
import { Message } from "./message.ts";
import {
  canSelectSession,
  canStop,
  canSubmit,
  canRefresh,
  canRetry,
  canConfigure,
  Dispatch,
  hasAcknowledgement,
  Model,
  ModelCombobox,
  selectedModelName,
} from "./model.ts";
import { ChatWorkflow, initialView, toWorkflowView } from "./workflow.ts";

export { Model } from "./model.ts";
export { Message } from "./message.ts";
export { view } from "./view.ts";

// INIT

/** Start with an empty draft while the workflow loads durable history. */
export const init = () => ({
  model: Model.make({
    draft: "",
    drafts: {},
    workspace: { sessions: [], memory: { text: "", revision: 0 } },
    workspaceActivity: "loading",
    workspaceGeneration: 0,
    maybeWorkspaceError: Option.none(),
    maybeCreation: Option.none(),
    threadPopover: Popover.init({ id: "threads", contentFocus: true, isAnimated: false }),
    threadQuery: "",
    threadFilter: "active",
    memoryDialog: Dialog.init({
      id: "shared-memory",
      isAnimated: false,
      focusSelector: "#shared-memory-text",
    }),
    memoryDraft: "",
    memoryRevision: 0,
    memorySaveState: "idle",
    maybeMemoryError: Option.none(),
    renameDialog: Dialog.init({
      id: "rename-thread",
      isAnimated: false,
      focusSelector: "#thread-name",
    }),
    maybeRenameSession: Option.none(),
    renameDraft: "",
    maybeCopiedMessage: Option.none(),
    workflow: initialView,
    dispatch: Dispatch.Idle(),
    maybeFeedback: Option.none(),
    modelCombobox: Combobox.init({ id: "model", isAnimated: false, selectInputOnFocus: true }),
    settingsPopover: Popover.init({ id: "settings", contentFocus: true }),
    workspacePopover: Popover.init({ id: "workspace", contentFocus: true }),
  }),
  commands: [LoadWorkspace({ generation: 0 }), ReadSelectedThread()],
});
// UPDATE

const foldSettingsPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.settingsPopover),
  write: (model, nextSettingsPopover) =>
    modifyFields(model, { settingsPopover: () => nextSettingsPopover }),
  toParentMessage: (message) => Message.GotSettingsPopoverMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) =>
      Update.combine(model, [
        closeThreadPopover,
        closeWorkspacePopover,
        (stepModel) => ({
          model: modifyFields(stepModel, {
            modelCombobox: (combobox) =>
              modifyFields(combobox, {
                inputValue: () => selectedModelName(stepModel.workflow.chat),
              }),
          }),
        }),
      ]),
    Closed: () => (model) => ({
      model: modifyFields(model, {
        modelCombobox: () =>
          Combobox.init({ id: "model", isAnimated: false, selectInputOnFocus: true }),
      }),
    }),
  }),
});
const foldWorkspacePopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.workspacePopover),
  write: (model, nextWorkspacePopover) =>
    modifyFields(model, { workspacePopover: () => nextWorkspacePopover }),
  toParentMessage: (message) => Message.GotWorkspacePopoverMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => Update.combine(model, [closeThreadPopover, closeSettingsPopover]),
    Closed: () => (model) => ({ model }),
  }),
});

const startRequest = (model: Model) =>
  modifyFields(model, {
    dispatch: () => Dispatch.Preparing(),
    maybeFeedback: () => Option.none(),
  });
const completeRequest = (model: Model, requestId: OperationId) =>
  modifyFields(model, {
    dispatch: () =>
      hasAcknowledgement(model.workflow, requestId)
        ? Dispatch.Idle()
        : Dispatch.AwaitingSnapshot({ requestId }),
  });

const configureModel = (model: Model, value: string) => {
  const choice = model.workflow.chat.models.find((entry) => entry.id === value);
  const current = model.workflow.chat.thinkingLevel;
  const thinkingLevel = choice?.thinkingLevels.includes(current)
    ? current
    : choice?.thinkingLevels[0];
  return canConfigure(model) && choice && thinkingLevel && value !== model.workflow.chat.model
    ? {
        model: startRequest(model),
        commands: [
          ConfigureSession({ settings: ModelSettings.make({ model: value, thinkingLevel }) }),
        ],
      }
    : { model };
};
const foldModelCombobox = Update.foldChild({
  update: ModelCombobox.update,
  read: (model: Model) => Option.some(model.modelCombobox),
  write: (model, nextModelCombobox) =>
    modifyFields(model, { modelCombobox: () => nextModelCombobox }),
  toParentMessage: (message) => Message.GotModelComboboxMessage({ message }),
  foldOutMessage: Combobox.OutMessage.match<
    Update.Step<Model, Message, ChatWorkflow | Crypto.Crypto>
  >({
    Selected:
      ({ value }) =>
      (model) =>
        configureModel(model, value),
    ClearedSelection: () => (model) => ({ model }),
  }),
});

/** Serialize UI intentions until the matching actor acknowledgement is projected. */
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, ChatWorkflow | Crypto.Crypto>>(message, {
    ...workspaceHandlers(model),
    ClickedStop: () =>
      canStop(model) ? { model: startRequest(model), commands: [StopWorkflow()] } : { model },
    CompletedStop: ({ requestId }) => ({ model: completeRequest(model, requestId) }),
    GotModelComboboxMessage: ({ message }) => foldModelCombobox(model, message),
    GotSettingsPopoverMessage: ({ message }) => foldSettingsPopover(model, message),
    GotWorkspacePopoverMessage: ({ message }) => foldWorkspacePopover(model, message),
    SelectedThinkingLevel: ({ value }) => {
      const chat = model.workflow.chat;
      const level = chat.models
        .find((entry) => entry.id === chat.model)
        ?.thinkingLevels.find((entry) => entry === value);
      return canConfigure(model) && level && level !== chat.thinkingLevel
        ? {
            model: startRequest(model),
            commands: [
              ConfigureSession({
                settings: ModelSettings.make({ model: chat.model, thinkingLevel: level }),
              }),
            ],
          }
        : { model };
    },
    CompletedConfigureSession: ({ requestId }) => ({ model: completeRequest(model, requestId) }),
    FailedConfigureSession: () => ({
      model: modifyFields(model, {
        dispatch: () => Dispatch.Idle(),
        maybeFeedback: () => Option.some("Could not prepare settings. Please try again."),
      }),
    }),
    UpdatedDraft: ({ value }) =>
      model.dispatch._tag === "Idle"
        ? { model: modifyFields(model, { draft: () => value }) }
        : { model },
    SubmittedPrompt: () =>
      canSubmit(model)
        ? {
            model: startRequest(model),
            commands: [
              SubmitPrompt({ prompt: model.draft.trim(), sessionId: model.workflow.sessionId }),
            ],
          }
        : { model },
    ClickedRefresh: () =>
      canRefresh(model)
        ? Update.combine(model, [
            closeWorkspacePopover,
            (stepModel) => ({ model: startRequest(stepModel), commands: [RefreshWorkflow()] }),
          ])
        : { model },
    ClickedRetry: () =>
      canRetry(model) ? { model: startRequest(model), commands: [RetryWorkflow()] } : { model },
    CompletedSubmitPrompt: ({ requestId, sessionId }) =>
      model.workflow.sessionId === sessionId
        ? {
            model: modifyFields(completeRequest(model, requestId), {
              draft: () =>
                model.workflow.phase === "submitRejected"
                  ? model.draft ||
                    Option.match(model.workflow.maybeSubmission, {
                      onNone: () => "",
                      onSome: (submission) => submission.prompt,
                    })
                  : "",
              drafts: (drafts) => Record.set(drafts, sessionId, ""),
            }),
          }
        : { model },
    CompletedRefreshWorkflow: ({ requestId }) => ({ model: completeRequest(model, requestId) }),
    CompletedRetryWorkflow: ({ requestId }) => ({ model: completeRequest(model, requestId) }),
    FailedSubmitPrompt: () => ({
      model: modifyFields(model, {
        dispatch: () => Dispatch.Idle(),
        maybeFeedback: () => Option.some("Could not prepare the message. Please try again."),
      }),
    }),
    FailedWorkflowRequest: () => ({
      model: modifyFields(model, {
        dispatch: () => Dispatch.Idle(),
        maybeFeedback: () => Option.some("Could not reconnect. Please try again."),
      }),
    }),
    UpdatedWorkflow: ({ workflow }) =>
      workflow.sessionId === ROOT_SESSION &&
      workflow.phase === "loading" &&
      model.workflow.sessionId !== ROOT_SESSION &&
      canSelectSession(model)
        ? {
            model: startRequest(model),
            commands: [SelectSession({ sessionId: model.workflow.sessionId })],
          }
        : {
            commands: [
              ...(workflow.sessionId !== model.workflow.sessionId
                ? [RememberSelectedThread({ sessionId: workflow.sessionId })]
                : []),
              ...(workflow.phase === "ready" &&
              model.workflow.phase !== "ready" &&
              model.workspaceActivity === "idle"
                ? [LoadWorkspace({ generation: model.workspaceGeneration + 1 })]
                : []),
            ],
            model: modifyFields(model, {
              workspaceGeneration: (generation) =>
                workflow.phase === "ready" &&
                model.workflow.phase !== "ready" &&
                model.workspaceActivity === "idle"
                  ? generation + 1
                  : generation,
              workspaceActivity: (activity) =>
                workflow.phase === "ready" &&
                model.workflow.phase !== "ready" &&
                activity === "idle"
                  ? "loading"
                  : activity,
              workflow: () => workflow,
              draft: (draft) =>
                workflow.sessionId === model.workflow.sessionId
                  ? workflow.phase === "submitRejected" && !draft
                    ? Option.match(workflow.maybeSubmission, {
                        onNone: () => draft,
                        onSome: (submission) => submission.prompt,
                      })
                    : draft
                  : (model.drafts[workflow.sessionId] ?? ""),
              drafts: (drafts) =>
                workflow.sessionId === model.workflow.sessionId
                  ? drafts
                  : Record.set(drafts, model.workflow.sessionId, model.draft),
              maybeCopiedMessage: (copied) =>
                workflow.chat.messages === model.workflow.chat.messages ? copied : Option.none(),
              modelCombobox: (combobox) =>
                combobox.isOpen
                  ? combobox
                  : modifyFields(combobox, { inputValue: () => selectedModelName(workflow.chat) }),
              dispatch: (dispatch) =>
                dispatch._tag === "AwaitingSnapshot" &&
                hasAcknowledgement(workflow, dispatch.requestId)
                  ? Dispatch.Idle()
                  : dispatch,
            }),
          },
  });

// COMMAND

const requestId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(
  Effect.flatMap(Schema.decodeEffect(OperationId)),
);
/** send() only enqueues. Wait for the machine to acknowledge this exact intention. */
const acknowledged = (id: OperationId) =>
  ChatWorkflow.use((actor) =>
    waitFor(
      actor,
      (snapshot) =>
        Option.exists(snapshot.context.maybeAcknowledgedRequestId, (value) => value === id),
      { timeout: "5 seconds" },
    ),
  );

export const SubmitPrompt = Command.define("SubmitPrompt", {
  args: { prompt: Schema.String, sessionId: SessionId },
  messages: [Message.CompletedSubmitPrompt, Message.FailedSubmitPrompt],
  execute: ({ prompt, sessionId }) =>
    Effect.gen(function* () {
      const id = yield* requestId;
      const actor = yield* ChatWorkflow;
      yield* send(actor, {
        type: "SUBMIT",
        submission: Submission.make({ operationId: id, prompt }),
      });
      yield* acknowledged(id);
      return Message.CompletedSubmitPrompt({ requestId: id, sessionId });
    }).pipe(Effect.orElseSucceed(() => Message.FailedSubmitPrompt())),
});
export const ConfigureSession = Command.define("ConfigureSession", {
  args: { settings: ModelSettings },
  messages: [Message.CompletedConfigureSession, Message.FailedConfigureSession],
  execute: ({ settings }) =>
    Effect.gen(function* () {
      const id = yield* requestId;
      const actor = yield* ChatWorkflow;
      yield* send(actor, { type: "CONFIGURE", requestId: id, settings });
      yield* acknowledged(id);
      return Message.CompletedConfigureSession({ requestId: id });
    }).pipe(Effect.orElseSucceed(() => Message.FailedConfigureSession())),
});
export const RetryWorkflow = Command.define("RetryWorkflow", {
  messages: [Message.CompletedRetryWorkflow, Message.FailedWorkflowRequest],
  execute: Effect.gen(function* () {
    const id = yield* requestId;
    const actor = yield* ChatWorkflow;
    yield* send(actor, { type: "RETRY", requestId: id });
    yield* acknowledged(id);
    return Message.CompletedRetryWorkflow({ requestId: id });
  }).pipe(Effect.orElseSucceed(() => Message.FailedWorkflowRequest())),
});
export const RefreshWorkflow = Command.define("RefreshWorkflow", {
  messages: [Message.CompletedRefreshWorkflow, Message.FailedWorkflowRequest],
  execute: Effect.gen(function* () {
    const id = yield* requestId;
    const actor = yield* ChatWorkflow;
    yield* send(actor, { type: "REFRESH", requestId: id });
    yield* acknowledged(id);
    return Message.CompletedRefreshWorkflow({ requestId: id });
  }).pipe(Effect.orElseSucceed(() => Message.FailedWorkflowRequest())),
});

export const StopWorkflow = Command.define("StopWorkflow", {
  messages: [Message.CompletedStop, Message.FailedWorkflowRequest],
  execute: Effect.gen(function* () {
    const id = yield* requestId;
    const actor = yield* ChatWorkflow;
    yield* send(actor, { type: "STOP", requestId: id });
    yield* acknowledged(id);
    return Message.CompletedStop({ requestId: id });
  }).pipe(Effect.orElseSucceed(() => Message.FailedWorkflowRequest())),
});

// SUBSCRIPTION

/** Observe the app-scoped actor through Foldkit's managed subscription lifetime. */
export const subscriptions = Subscription.make<Model, Message, ChatWorkflow>()((entry) => ({
  submitShortcut: entry(
    { isEnabled: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isEnabled: canSubmit(model) }),
      dependenciesToStream: ({ isEnabled }) =>
        Dom.streamFromKeyBindings({
          bindings: [
            {
              keys: "Mod+Enter",
              isEnabled,
              whileTyping: "Allow",
              mapEvent: () => Message.SubmittedPrompt(),
            },
          ],
        }),
    },
  ),
  workflow: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(ChatWorkflow.use((actor) => Effect.succeed(snapshots(actor)))).pipe(
          Stream.map((snapshot) => Message.UpdatedWorkflow({ workflow: toWorkflowView(snapshot) })),
        ),
    },
  ),
}));
