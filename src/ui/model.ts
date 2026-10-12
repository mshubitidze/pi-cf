import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as String from "effect/String";
import { defineTaggedUnion } from "foldkit/schema";
import {
  MAX_PROMPT_LENGTH,
  OperationId,
  CreateSession,
  SessionId,
  WorkspaceState,
  type ChatState,
} from "../model.ts";
import { WorkflowView } from "./workflow.ts";
import * as Combobox from "./components/ui/combobox.ts";
import * as Dialog from "./components/ui/dialog.ts";
import * as Popover from "./components/ui/popover.ts";

export const ModelCombobox = Combobox.create<string>();
export const selectedModelName = (chat: ChatState) =>
  chat.models.find((choice) => choice.id === chat.model)?.name ?? chat.model;

/** Local dispatch is locked until actor acknowledgement and its projection agree. */
export const Dispatch = defineTaggedUnion({
  Idle: {},
  Preparing: {},
  AwaitingSnapshot: { requestId: OperationId },
});
export const Model = Schema.Struct({
  draft: Schema.String,
  drafts: Schema.Record(Schema.String, Schema.String),
  workspace: WorkspaceState,
  workspaceGeneration: Schema.Finite,
  workspaceActivity: Schema.Literals(["idle", "loading", "mutating", "createFailed"]),
  maybeWorkspaceError: Schema.Option(Schema.String),
  maybeCreation: Schema.Option(CreateSession),
  threadPopover: Popover.Model,
  threadQuery: Schema.String,
  threadFilter: Schema.Literals(["active", "archived"]),
  memoryDialog: Dialog.Model,
  memoryDraft: Schema.String,
  memoryRevision: Schema.Finite,
  memorySaveState: Schema.Literals(["idle", "saving", "failed", "conflict", "review"]),
  maybeMemoryError: Schema.Option(Schema.String),
  renameDialog: Dialog.Model,
  maybeRenameSession: Schema.Option(SessionId),
  renameDraft: Schema.String,
  maybeCopiedMessage: Schema.Option(Schema.String),
  workflow: WorkflowView,
  dispatch: Dispatch,
  maybeFeedback: Schema.Option(Schema.String),
  settingsPopover: Popover.Model,
  modelCombobox: Combobox.Model,
  workspacePopover: Popover.Model,
});
export type Model = typeof Model.Type;
export const canSubmit = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  !model.memoryDialog.isOpen &&
  !model.renameDialog.isOpen &&
  model.workspaceActivity !== "mutating" &&
  model.workflow.phase === "ready" &&
  !selectedSession(model)?.archived &&
  model.workflow.chat.connection === "connected" &&
  String.isNonEmpty(model.draft.trim()) &&
  model.draft.length <= MAX_PROMPT_LENGTH;
export const canRefresh = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  ["ready", "submitRejected", "settingsFailed", "stopFailed", "reconcileFailed"].includes(
    model.workflow.phase,
  );
export const canConfigure = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  model.workflow.phase === "ready" &&
  model.workflow.chat.connection === "connected";
export const canRetry = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  ["loadFailed", "submitRejected", "submitFailed", "waitFailed", "reconcileFailed"].includes(
    model.workflow.phase,
  );
export const hasAcknowledgement = (workflow: WorkflowView, id: OperationId) =>
  Option.exists(workflow.maybeAcknowledgedRequestId, (value) => value === id);

export const canSelectSession = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  model.workspaceActivity !== "mutating" &&
  ["loading", "ready", "submitRejected", "waiting", "loadFailed", "waitFailed"].includes(
    model.workflow.phase,
  );
export const canStop = (model: Model) =>
  model.dispatch._tag === "Idle" && ["waiting", "waitFailed"].includes(model.workflow.phase);
export const selectedSession = (model: Model) =>
  model.workspace.sessions.find((session) => session.id === model.workflow.sessionId);
export const selectedSessionTitle = (model: Model) => selectedSession(model)?.title ?? "Pi";
