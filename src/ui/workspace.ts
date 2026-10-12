import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { send, waitFor } from "@xstate/effect";
import { selectedThreadFromUrl, workspaceRouter } from "./navigation.ts";
import { replaceUrl } from "foldkit/navigation";
import { Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import * as Update from "foldkit/update";
import {
  CreateSession,
  OperationId,
  SessionId,
  UpdateSession,
  MAX_MEMORY_LENGTH,
} from "../model.ts";
import { ChatApi } from "./api.ts";
import { ChatWorkflow } from "./workflow.ts";
import { closeThreadPopover, closeWorkspacePopover, closeSettingsPopover } from "./overlays.ts";
import { Message } from "./message.ts";
import {
  canSelectSession,
  Dispatch,
  hasAcknowledgement,
  selectedSessionTitle,
  type Model,
} from "./model.ts";
import * as Dialog from "./components/ui/dialog.ts";
import * as Popover from "./components/ui/popover.ts";

export const ReadSelectedThread = Command.define("ReadSelectedThread", {
  messages: [Message.CompletedReadSelectedThread],
  execute: Effect.sync(() => selectedThreadFromUrl(window.location.href)).pipe(
    Effect.map((maybeSessionId) => Message.CompletedReadSelectedThread({ maybeSessionId })),
    Effect.orElseSucceed(() =>
      Message.CompletedReadSelectedThread({ maybeSessionId: Option.none() }),
    ),
  ),
});
export const RememberSelectedThread = Command.define("RememberSelectedThread", {
  args: { sessionId: SessionId },
  messages: [Message.CompletedRememberSelectedThread, Message.FailedRememberSelectedThread],
  execute: ({ sessionId }) =>
    replaceUrl(workspaceRouter({ thread: Option.some(sessionId) })).pipe(
      Effect.as(Message.CompletedRememberSelectedThread()),
      Effect.orElseSucceed(() => Message.FailedRememberSelectedThread()),
    ),
});
export const LoadWorkspace = Command.define("LoadWorkspace", {
  args: { generation: Schema.Finite },
  messages: [Message.CompletedLoadWorkspace, Message.FailedLoadWorkspace],
  execute: ({ generation }) =>
    ChatApi.use((api) => api.workspace).pipe(
      Effect.map((workspace) => Message.CompletedLoadWorkspace({ workspace, generation })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLoadWorkspace({ error: error.message, generation })),
      ),
      Effect.provide(ChatApi.layer),
    ),
});
export const PrepareThread = Command.define("PrepareThread", {
  args: { title: Schema.String, maybeForkFrom: Schema.Option(SessionId) },
  messages: [Message.CompletedPrepareThread, Message.FailedPrepareThread],
  execute: ({ title, maybeForkFrom }) =>
    Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(
      Effect.flatMap(Schema.decodeEffect(OperationId)),
      Effect.map((operationId) =>
        Message.CompletedPrepareThread({
          input: CreateSession.make({
            operationId,
            title,
            ...Option.match(maybeForkFrom, {
              onNone: () => ({}),
              onSome: (forkFrom) => ({ forkFrom }),
            }),
          }),
        }),
      ),
      Effect.orElseSucceed(() => Message.FailedPrepareThread()),
    ),
});
export const CreateThread = Command.define("CreateThread", {
  args: { input: CreateSession },
  messages: [Message.CompletedCreateThread, Message.FailedCreateThread],
  execute: ({ input }) =>
    ChatApi.use((api) => api.createSession(input)).pipe(
      Effect.map((result) => Message.CompletedCreateThread({ result })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCreateThread({
            error: error.message,
            rejected: error.reason !== undefined,
          }),
        ),
      ),
      Effect.provide(ChatApi.layer),
    ),
});
export const UpdateThread = Command.define("UpdateThread", {
  args: { sessionId: SessionId, input: UpdateSession },
  messages: [Message.CompletedUpdateThread, Message.FailedUpdateThread],
  execute: ({ sessionId, input }) =>
    ChatApi.use((api) => api.updateSession(sessionId, input)).pipe(
      Effect.map((workspace) => Message.CompletedUpdateThread({ workspace })),
      Effect.catch((error) => Effect.succeed(Message.FailedUpdateThread({ error: error.message }))),
      Effect.provide(ChatApi.layer),
    ),
});
export const SaveMemory = Command.define("SaveMemory", {
  args: { text: Schema.String, revision: Schema.Finite },
  messages: [Message.CompletedSaveMemory, Message.FailedSaveMemory],
  execute: (input) =>
    ChatApi.use((api) => api.saveMemory(input)).pipe(
      Effect.map((workspace) => Message.CompletedSaveMemory({ workspace })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveMemory({ error: error.message, conflict: error.reason === "conflict" }),
        ),
      ),
      Effect.provide(ChatApi.layer),
    ),
});
export const SelectSession = Command.define("SelectSession", {
  args: { sessionId: SessionId },
  messages: [Message.CompletedSelectSession, Message.FailedWorkflowRequest],
  execute: ({ sessionId }) =>
    Effect.gen(function* () {
      const requestId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(
        Effect.flatMap(Schema.decodeEffect(OperationId)),
      );
      const actor = yield* ChatWorkflow;
      yield* send(actor, { type: "SELECT_SESSION", sessionId, requestId });
      yield* waitFor(
        actor,
        (snapshot) =>
          Option.exists(snapshot.context.maybeAcknowledgedRequestId, (id) => id === requestId),
        { timeout: "5 seconds" },
      );
      return Message.CompletedSelectSession({ requestId });
    }).pipe(Effect.orElseSucceed(() => Message.FailedWorkflowRequest())),
});
export const CopyReply = Command.define("CopyReply", {
  args: { messageId: Schema.String, text: Schema.String },
  messages: [Message.CompletedCopyReply, Message.FailedCopyReply],
  execute: ({ messageId, text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.as(Message.CompletedCopyReply({ messageId })),
      Effect.orElseSucceed(() => Message.FailedCopyReply()),
    ),
});
export const ExportConversation = Command.define("ExportConversation", {
  args: { title: Schema.String, markdown: Schema.String },
  messages: [Message.CompletedExportConversation, Message.FailedExportConversation],
  execute: ({ title, markdown }) =>
    Effect.try(() => {
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100) || "conversation"}.md`;
      link.click();
      URL.revokeObjectURL(url);
      return Message.CompletedExportConversation();
    }).pipe(Effect.orElseSucceed(() => Message.FailedExportConversation())),
});

const foldThreadPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.threadPopover),
  write: (model, nextThreadPopover) =>
    modifyFields(model, { threadPopover: () => nextThreadPopover }),
  toParentMessage: (message) => Message.GotThreadPopoverMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) =>
      Update.combine(model, [
        closeWorkspacePopover,
        closeSettingsPopover,
        (stepModel) =>
          stepModel.workspaceActivity === "idle"
            ? {
                model: modifyFields(stepModel, {
                  workspaceGeneration: (generation) => generation + 1,
                  workspaceActivity: () => "loading",
                }),
                commands: [LoadWorkspace({ generation: stepModel.workspaceGeneration + 1 })],
              }
            : { model: stepModel },
      ]),
    Closed: () => (model) => ({ model }),
  }),
});
const foldMemoryDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.memoryDialog),
  write: (model, nextMemoryDialog) => modifyFields(model, { memoryDialog: () => nextMemoryDialog }),
  toParentMessage: (message) => Message.GotMemoryDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const foldRenameDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.renameDialog),
  write: (model, nextRenameDialog) => modifyFields(model, { renameDialog: () => nextRenameDialog }),
  toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const openMemoryDialog = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.memoryDialog),
  write: (model, nextMemoryDialog) => modifyFields(model, { memoryDialog: () => nextMemoryDialog }),
  toParentMessage: (message) => Message.GotMemoryDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const closeMemoryDialog = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.memoryDialog),
  write: (model, nextMemoryDialog) => modifyFields(model, { memoryDialog: () => nextMemoryDialog }),
  toParentMessage: (message) => Message.GotMemoryDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const openRenameDialog = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.renameDialog),
  write: (model, nextRenameDialog) => modifyFields(model, { renameDialog: () => nextRenameDialog }),
  toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const closeRenameDialog = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.renameDialog),
  write: (model, nextRenameDialog) => modifyFields(model, { renameDialog: () => nextRenameDialog }),
  toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const select = (
  model: Model,
  sessionId: SessionId,
): Update.Return<Model, Message, ChatWorkflow | Crypto.Crypto> => {
  if (!canSelectSession(model) || sessionId === model.workflow.sessionId) {
    return { model };
  }
  const popoverClose = closeThreadPopover(model);
  return {
    model: modifyFields(popoverClose.model, {
      dispatch: () => Dispatch.Preparing(),
      maybeFeedback: () => Option.none(),
    }),
    commands: [...(popoverClose.commands ?? []), SelectSession({ sessionId })],
  };
};
const beginCreation = (model: Model, fork: boolean) =>
  canSelectSession(model) && model.workspaceActivity === "idle"
    ? {
        model: modifyFields(model, {
          workspaceGeneration: (generation) => generation + 1,
          workspaceActivity: () => "mutating",
          maybeWorkspaceError: () => Option.none(),
        }),
        commands: [
          PrepareThread({
            title: fork ? `${selectedSessionTitle(model).slice(0, 112)} (fork)` : "",
            maybeForkFrom: fork ? Option.some(model.workflow.sessionId) : Option.none(),
          }),
        ],
      }
    : { model };

export const workspaceHandlers = (model: Model) => ({
  CompletedReadSelectedThread: ({
    maybeSessionId,
  }: typeof Message.CompletedReadSelectedThread.Type) =>
    Option.match(maybeSessionId, {
      onNone: () => ({ model }),
      onSome: (sessionId) => select(model, sessionId),
    }),
  CompletedRememberSelectedThread: () => ({ model }),
  FailedRememberSelectedThread: () => ({
    model: modifyFields(model, {
      maybeFeedback: () => Option.some("Could not keep this thread in the page URL."),
    }),
  }),
  GotThreadPopoverMessage: ({ message }: typeof Message.GotThreadPopoverMessage.Type) =>
    foldThreadPopover(model, message),
  GotMemoryDialogMessage: ({ message }: typeof Message.GotMemoryDialogMessage.Type) =>
    foldMemoryDialog(model, message),
  GotRenameDialogMessage: ({ message }: typeof Message.GotRenameDialogMessage.Type) =>
    foldRenameDialog(model, message),
  UpdatedThreadQuery: ({ value }: typeof Message.UpdatedThreadQuery.Type) => ({
    model: modifyFields(model, { threadQuery: () => value }),
  }),
  SelectedThreadFilter: ({ value }: typeof Message.SelectedThreadFilter.Type) => ({
    model: modifyFields(model, { threadFilter: () => value }),
  }),
  SelectedSession: ({ sessionId }: typeof Message.SelectedSession.Type) => select(model, sessionId),
  CompletedSelectSession: ({ requestId }: typeof Message.CompletedSelectSession.Type) => ({
    model: modifyFields(model, {
      dispatch: () =>
        hasAcknowledgement(model.workflow, requestId)
          ? Dispatch.Idle()
          : Dispatch.AwaitingSnapshot({ requestId }),
    }),
  }),
  ClickedNewThread: () =>
    Update.combine(model, [
      closeWorkspacePopover,
      closeThreadPopover,
      closeSettingsPopover,
      (stepModel) => beginCreation(stepModel, false),
    ]),
  ClickedForkThread: () =>
    Update.combine(model, [closeWorkspacePopover, (stepModel) => beginCreation(stepModel, true)]),
  CompletedPrepareThread: ({ input }: typeof Message.CompletedPrepareThread.Type) => ({
    model: modifyFields(model, { maybeCreation: () => Option.some(input) }),
    commands: [CreateThread({ input })],
  }),
  FailedPrepareThread: () => ({
    model: modifyFields(model, {
      workspaceActivity: () => "idle",
      maybeWorkspaceError: () => Option.some("Could not prepare a thread. Please try again."),
    }),
  }),
  CompletedCreateThread: ({ result }: typeof Message.CompletedCreateThread.Type) =>
    select(
      modifyFields(model, {
        workspace: () => result.workspace,
        workspaceActivity: () => "idle",
        maybeCreation: () => Option.none(),
        maybeWorkspaceError: () => Option.none(),
      }),
      result.sessionId,
    ),
  FailedCreateThread: ({ error, rejected }: typeof Message.FailedCreateThread.Type) => ({
    model: modifyFields(model, {
      workspaceActivity: () => (rejected ? "idle" : "createFailed"),
      maybeCreation: (creation) => (rejected ? Option.none() : creation),
      maybeWorkspaceError: () => Option.some(error),
    }),
  }),
  ClickedRetryCreateThread: () =>
    model.workspaceActivity !== "createFailed"
      ? { model }
      : Option.match(model.maybeCreation, {
          onNone: () => ({ model }),
          onSome: (input) => ({
            model: modifyFields(model, {
              workspaceGeneration: (generation) => generation + 1,
              workspaceActivity: () => "mutating",
              maybeWorkspaceError: () => Option.none(),
            }),
            commands: [CreateThread({ input })],
          }),
        }),
  CompletedLoadWorkspace: ({
    workspace,
    generation,
  }: typeof Message.CompletedLoadWorkspace.Type) =>
    generation !== model.workspaceGeneration
      ? { model }
      : {
          model: modifyFields(model, {
            workspace: () => workspace,
            memorySaveState: (state) => (state === "conflict" ? "review" : state),
            workspaceActivity: (activity) => (activity === "loading" ? "idle" : activity),
            maybeWorkspaceError: () => Option.none(),
          }),
        },
  FailedLoadWorkspace: ({ error, generation }: typeof Message.FailedLoadWorkspace.Type) =>
    generation !== model.workspaceGeneration
      ? { model }
      : {
          model: modifyFields(model, {
            workspaceActivity: (activity) => (activity === "loading" ? "idle" : activity),
            maybeWorkspaceError: () => Option.some(error),
          }),
        },
  ClickedRenameThread: ({ sessionId }: typeof Message.ClickedRenameThread.Type) => {
    const session = model.workspace.sessions.find((entry) => entry.id === sessionId);
    return session
      ? openRenameDialog(
          modifyFields(model, {
            maybeRenameSession: () => Option.some(sessionId),
            renameDraft: () => session.title,
            maybeWorkspaceError: () => Option.none(),
          }),
        )
      : { model };
  },
  UpdatedRenameDraft: ({ value }: typeof Message.UpdatedRenameDraft.Type) => ({
    model: modifyFields(model, { renameDraft: () => value }),
  }),
  SubmittedRenameThread: () =>
    Option.match(model.maybeRenameSession, {
      onNone: () => ({ model }),
      onSome: (sessionId) => {
        const session = model.workspace.sessions.find((entry) => entry.id === sessionId);
        const title = model.renameDraft.trim();
        return session && title && title.length <= 120 && model.workspaceActivity === "idle"
          ? {
              model: modifyFields(model, {
                workspaceGeneration: (generation) => generation + 1,
                workspaceActivity: () => "mutating",
              }),
              commands: [
                UpdateThread({
                  sessionId,
                  input: UpdateSession.make({ title, archived: session.archived }),
                }),
              ],
            }
          : { model };
      },
    }),
  ClickedArchiveThread: ({ sessionId }: typeof Message.ClickedArchiveThread.Type) => {
    const session = model.workspace.sessions.find((entry) => entry.id === sessionId);
    return session && !session.busy && model.workspaceActivity === "idle"
      ? {
          model: modifyFields(model, {
            workspaceGeneration: (generation) => generation + 1,
            workspaceActivity: () => "mutating",
            maybeWorkspaceError: () => Option.none(),
          }),
          commands: [
            UpdateThread({
              sessionId,
              input: UpdateSession.make({ title: session.title, archived: !session.archived }),
            }),
          ],
        }
      : { model };
  },
  CompletedUpdateThread: ({ workspace }: typeof Message.CompletedUpdateThread.Type) =>
    closeRenameDialog(
      modifyFields(model, {
        workspace: () => workspace,
        workspaceActivity: () => "idle",
        maybeWorkspaceError: () => Option.none(),
      }),
    ),
  FailedUpdateThread: ({ error }: typeof Message.FailedUpdateThread.Type) => ({
    model: modifyFields(model, {
      workspaceActivity: () => "idle",
      maybeWorkspaceError: () => Option.some(error),
    }),
  }),
  ClickedSharedMemory: () =>
    Update.combine(model, [
      closeWorkspacePopover,
      (stepModel) =>
        openMemoryDialog(
          modifyFields(stepModel, {
            memoryDraft: (draft) =>
              stepModel.memorySaveState !== "idle" ? draft : stepModel.workspace.memory.text,
            memoryRevision: (revision) =>
              stepModel.memorySaveState !== "idle" ? revision : stepModel.workspace.memory.revision,
          }),
        ),
    ]),
  UpdatedMemoryDraft: ({ value }: typeof Message.UpdatedMemoryDraft.Type) =>
    model.memorySaveState === "saving"
      ? { model }
      : { model: modifyFields(model, { memoryDraft: () => value }) },
  ClickedSaveMemory: () =>
    model.workspaceActivity === "idle" &&
    model.memorySaveState !== "saving" &&
    model.memorySaveState !== "conflict" &&
    model.memoryDraft.length <= MAX_MEMORY_LENGTH
      ? {
          model: modifyFields(model, {
            memoryRevision: (revision) =>
              model.memorySaveState === "review" ? model.workspace.memory.revision : revision,
            memorySaveState: () => "saving",
            workspaceGeneration: (generation) => generation + 1,
            workspaceActivity: () => "mutating",
            maybeMemoryError: () => Option.none(),
          }),
          commands: [
            SaveMemory({
              text: model.memoryDraft,
              revision:
                model.memorySaveState === "review"
                  ? model.workspace.memory.revision
                  : model.memoryRevision,
            }),
          ],
        }
      : { model },
  ClickedReloadMemory: () =>
    model.workspaceActivity !== "idle"
      ? { model }
      : {
          model: modifyFields(model, {
            workspaceGeneration: (generation) => generation + 1,
            workspaceActivity: () => "loading",
          }),
          commands: [LoadWorkspace({ generation: model.workspaceGeneration + 1 })],
        },
  CompletedSaveMemory: ({ workspace }: typeof Message.CompletedSaveMemory.Type) =>
    closeMemoryDialog(
      modifyFields(model, {
        workspace: () => workspace,
        workspaceActivity: () => "idle",
        memorySaveState: () => "idle",
        memoryRevision: () => workspace.memory.revision,
        maybeMemoryError: () => Option.none(),
      }),
    ),
  FailedSaveMemory: ({ error, conflict }: typeof Message.FailedSaveMemory.Type) => ({
    model: modifyFields(model, {
      workspaceActivity: () => "idle",
      memorySaveState: () => (conflict ? "conflict" : "failed"),
      maybeMemoryError: () => Option.some(error),
    }),
  }),
  ClickedCopyReply: ({ messageId, text }: typeof Message.ClickedCopyReply.Type) => ({
    model,
    commands: [CopyReply({ messageId, text })],
  }),
  CompletedCopyReply: ({ messageId }: typeof Message.CompletedCopyReply.Type) => ({
    model: modifyFields(model, { maybeCopiedMessage: () => Option.some(messageId) }),
  }),
  FailedCopyReply: () => ({
    model: modifyFields(model, {
      maybeFeedback: () => Option.some("Could not copy this reply. Select the text to copy it."),
    }),
  }),
  ClickedExportConversation: () =>
    Update.combine(model, [
      closeWorkspacePopover,
      (stepModel) => ({
        model: stepModel,
        commands: [
          ExportConversation({
            title: selectedSessionTitle(model),
            markdown: `# ${selectedSessionTitle(model)}\n\n${model.workflow.chat.messages.map((message) => `## ${message.role === "user" ? "You" : "Pi"}\n\n${message.text}`).join("\n\n")}\n`,
          }),
        ],
      }),
    ]),
  CompletedExportConversation: () => ({ model }),
  FailedExportConversation: () => ({
    model: modifyFields(model, {
      maybeFeedback: () => Option.some("Could not export this conversation. Please try again."),
    }),
  }),
});
