import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as String from "effect/String";
import { defineTaggedUnion } from "foldkit/schema";
import { MAX_PROMPT_LENGTH, OperationId, type ChatState } from "../model.ts";
import { WorkflowView } from "./workflow.ts";
import * as Combobox from "./components/ui/combobox.ts";
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
  model.workflow.phase === "ready" &&
  model.workflow.chat.connection === "connected" &&
  String.isNonEmpty(model.draft.trim()) &&
  model.draft.length <= MAX_PROMPT_LENGTH;
export const canRefresh = (model: Model) =>
  model.dispatch._tag === "Idle" && ["ready", "settingsFailed"].includes(model.workflow.phase);
export const canConfigure = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  model.workflow.phase === "ready" &&
  model.workflow.chat.connection === "connected";
export const canRetry = (model: Model) =>
  model.dispatch._tag === "Idle" &&
  ["loadFailed", "submitFailed", "waitFailed"].includes(model.workflow.phase);
export const hasAcknowledgement = (workflow: WorkflowView, id: OperationId) =>
  Option.exists(workflow.maybeAcknowledgedRequestId, (value) => value === id);
