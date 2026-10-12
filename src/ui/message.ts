import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { OperationId } from "../model.ts";
import { WorkflowView } from "./workflow.ts";
import * as Combobox from "./components/ui/combobox.ts";
import * as Popover from "./components/ui/popover.ts";
export const Message = defineMessageUnion({
  GotModelComboboxMessage: { message: Combobox.Message },
  GotSettingsPopoverMessage: { message: Popover.Message },
  GotWorkspacePopoverMessage: { message: Popover.Message },
  UpdatedDraft: { value: Schema.String },
  SelectedThinkingLevel: { value: Schema.String },
  CompletedConfigureSession: { requestId: OperationId },
  FailedConfigureSession: {},
  SubmittedPrompt: {},
  ClickedRetry: {},
  ClickedRefresh: {},
  UpdatedWorkflow: { workflow: WorkflowView },
  CompletedSubmitPrompt: { requestId: OperationId },
  FailedSubmitPrompt: {},
  CompletedRetryWorkflow: { requestId: OperationId },
  CompletedRefreshWorkflow: { requestId: OperationId },
  FailedWorkflowRequest: {},
});
export type Message = typeof Message.Type;
