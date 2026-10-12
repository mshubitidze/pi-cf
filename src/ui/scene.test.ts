import { Animation, Combobox, Popover } from "@foldkit/ui";
import * as Option from "effect/Option";
import { test } from "bun:test";
import {
  Command,
  Mount,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  Subscription,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import {
  init,
  Message,
  ConfigureSession,
  RetryWorkflow,
  SubmitPrompt,
  update,
  view,
} from "./main.ts";
import { MAX_PROMPT_LENGTH, ModelSettings, ChatState, OperationId, Submission } from "../model.ts";
import { WorkflowView } from "./workflow.ts";

test("a connected user can compose a message and sees preparation errors accessibly", () => {
  scene(
    { update, view },
    given(init().model),
    expect(role("heading", { name: "What’s on your mind?" })).toBeVisible(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: WorkflowView.make({
          phase: "ready",
          maybeError: Option.none(),
          maybeSubmission: Option.none(),
          maybeAcknowledgedRequestId: Option.none(),
          chat: ChatState.make({
            messages: [],
            pending: [],
            connection: "connected",
            model: "test",
            thinkingLevel: "low",
            models: [],
          }),
        }),
      }),
    ),
    type(label("Message Pi"), "Hello"),
    submit(role("form")),
    Command.resolve(SubmitPrompt, Message.FailedSubmitPrompt()),
    expect(text("Could not prepare the message. Please try again.")).toBeVisible(),
    expect(label("Message Pi")).toHaveValue("Hello"),
  );
});

test("missing login keeps sending disabled and explains how to connect", () => {
  scene(
    { update, view },
    given(init().model),
    expect(text("Opening your conversation…")).toBeVisible(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: WorkflowView.make({
          phase: "ready",
          chat: ChatState.make({
            messages: [],
            pending: [],
            connection: "missing",
            model: "test",
            thinkingLevel: "low",
            models: [],
          }),
          maybeError: Option.none(),
          maybeSubmission: Option.none(),
          maybeAcknowledgedRequestId: Option.none(),
        }),
      }),
    ),
    type(label("Message Pi"), "Hello"),
    expect(role("button", { name: "Send message" })).toBeDisabled(),
    expect(
      text(
        "ChatGPT is not connected. Reconnect the app’s ChatGPT account, then refresh this conversation.",
      ),
    ).toBeVisible(),
  );
});

test("history remains visible while waiting and reconnect errors offer Retry", () => {
  const chat = ChatState.make({
    messages: [{ id: "one", role: "assistant", text: "Saved reply" }],
    pending: [OperationId.make("pending-test-123")],
    connection: "connected",
    model: "test",
    thinkingLevel: "low",
    models: [],
  });
  const waiting = WorkflowView.make({
    phase: "waiting",
    chat,
    maybeError: Option.none(),
    maybeSubmission: Option.none(),
    maybeAcknowledgedRequestId: Option.none(),
  });
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.UpdatedWorkflow({ workflow: waiting })),
    expect(role("heading", { name: "Pi", level: 1 })).toBeVisible(),
    expect(text("Saved reply")).toBeVisible(),
    expect(text("Pi is working…")).toBeVisible(),
    expect(role("button", { name: "Send message" })).toBeDisabled(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: WorkflowView.make({
          ...waiting,
          phase: "waitFailed",
          maybeError: Option.some("Connection failed"),
        }),
      }),
    ),
    expect(role("alert")).toBeVisible(),
    click(role("button", { name: "Retry" })),
    Command.resolve(RetryWorkflow, Message.FailedWorkflowRequest()),
    expect(text("Could not reconnect. Please try again.")).toBeVisible(),
    expect(text("Saved reply")).toBeVisible(),
  );
});

test("accepted submission clears the draft and uncertain delivery preserves its echo through retry", () => {
  const requestId = OperationId.make("scene-submission-123");
  const retryId = OperationId.make("scene-retry-123");
  const ready = WorkflowView.make({
    phase: "ready",
    chat: ChatState.make({
      messages: [],
      pending: [],
      connection: "connected",
      model: "test",
      thinkingLevel: "low",
      models: [],
    }),
    maybeError: Option.none(),
    maybeSubmission: Option.none(),
    maybeAcknowledgedRequestId: Option.none(),
  });
  const submitting: WorkflowView = modifyFields(ready, {
    phase: () => "submitting",
    maybeSubmission: () =>
      Option.some(Submission.make({ operationId: requestId, prompt: "Hello Pi" })),
    maybeAcknowledgedRequestId: () => Option.some(requestId),
  });
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.UpdatedWorkflow({ workflow: ready })),
    type(label("Message Pi"), "Hello Pi"),
    submit(role("form")),
    Command.resolve(SubmitPrompt, Message.CompletedSubmitPrompt({ requestId })),
    Subscription.emit(Message.UpdatedWorkflow({ workflow: submitting })),
    expect(label("Message Pi")).toHaveValue(""),
    expect(text("Sending…")).toBeVisible(),
    expect(text("Hello Pi")).toBeVisible(),
    expect(role("button", { name: "Send message" })).toBeDisabled(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(submitting, {
          phase: () => "submitFailed",
          maybeError: () => Option.some("Delivery failed"),
        }),
      }),
    ),
    expect(text("Message delivery uncertain")).toBeVisible(),
    expect(role("alert")).toBeVisible(),
    click(role("button", { name: "Retry" })),
    Command.resolve(RetryWorkflow, Message.CompletedRetryWorkflow({ requestId: retryId })),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(submitting, {
          maybeAcknowledgedRequestId: () => Option.some(retryId),
        }),
      }),
    ),
    expect(text("Sending…")).toBeVisible(),
    expect(text("Hello Pi")).toBeVisible(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(ready, {
          chat: () =>
            modifyFields(ready.chat, {
              messages: () => [
                { id: "user-1", role: "user", text: "Hello Pi" },
                { id: "assistant-1", role: "assistant", text: "Hello back" },
              ],
            }),
        }),
      }),
    ),
    expect(text("Hello Pi")).toBeVisible(),
    expect(text("Hello back")).toBeVisible(),
    expect(role("heading", { name: "Pi", level: 1 })).toBeVisible(),
  );
});

test("initial load failure offers a retry and recovers the conversation", () => {
  const requestId = OperationId.make("load-retry-123");
  const failed: WorkflowView = modifyFields(init().model.workflow, {
    phase: () => "loadFailed",
    maybeError: () => Option.some("Connection failed"),
  });
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.UpdatedWorkflow({ workflow: failed })),
    expect(text("Connection interrupted")).toBeVisible(),
    expect(role("alert")).toBeVisible(),
    click(role("button", { name: "Retry" })),
    Command.resolve(RetryWorkflow, Message.CompletedRetryWorkflow({ requestId })),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(failed, {
          phase: () => "loading",
          maybeError: () => Option.none(),
          maybeAcknowledgedRequestId: () => Option.some(requestId),
        }),
      }),
    ),
    expect(text("Opening your conversation…")).toBeVisible(),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(failed, {
          phase: () => "ready",
          maybeError: () => Option.none(),
        }),
      }),
    ),
    expect(role("heading", { name: "Pi", level: 1 })).toBeVisible(),
  );
});

test("over-limit drafts explain the disabled send button and clear validation when shortened", () => {
  const connected = modifyFields(init().model, {
    workflow: (workflow) =>
      modifyFields(workflow, {
        phase: () => "ready",
        chat: (chat) => modifyFields(chat, { connection: () => "connected" }),
      }),
  });
  scene(
    { update, view },
    given(connected),
    expect(text("Enter for a new line · ⌘/Ctrl + Enter to send")).toHaveAttr("aria-live", "polite"),
    type(label("Message Pi"), "a".repeat(MAX_PROMPT_LENGTH + 12)),
    expect(text("Remove 12 characters to send this message.")).toHaveAttr("aria-live", "polite"),
    expect(text("Remove 12 characters to send this message.")).toHaveAttr("aria-atomic", "true"),
    expect(label("Message Pi")).toHaveAttr("aria-invalid", "true"),
    expect(label("Message Pi")).toHaveAccessibleDescription(
      "Remove 12 characters to send this message.",
    ),
    expect(role("button", { name: "Send message" })).toBeDisabled(),
    type(label("Message Pi"), "A shorter message"),
    expect(label("Message Pi")).toHaveAccessibleDescription(
      "Enter for a new line · ⌘/Ctrl + Enter to send",
    ),
    expect(role("button", { name: "Send message" })).toBeEnabled(),
  );
});

test("model selection saves a compatible pair, locks competing actions, and preserves the draft", () => {
  const requestId = OperationId.make("settings-scene-request");
  const ready: WorkflowView = modifyFields(init().model.workflow, {
    phase: () => "ready",
    chat: (chat) =>
      modifyFields(chat, {
        connection: () => "connected",
        model: () => "reasoning-model",
        thinkingLevel: () => "high",
        models: () => [
          { id: "reasoning-model", name: "Reasoning model", thinkingLevels: ["low", "high"] },
          { id: "plain-model", name: "Plain model", thinkingLevels: ["off"] },
        ],
      }),
  });
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.UpdatedWorkflow({ workflow: ready })),
    type(label("Message Pi"), "Keep my draft"),
    click(role("button", { name: "Conversation settings" })),
    Mount.resolve(Popover.PortalPopoverBackdrop, Popover.Message.CompletedPortalPopoverBackdrop()),
    Mount.resolve(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover()),
    Command.resolve(
      Animation.WaitForPaint,
      Animation.Message.CompletedWaitForPaint({ generation: 1 }),
    ),
    Command.resolve(
      Animation.WaitForAnimationSettled,
      Animation.Message.EndedAnimation({ generation: 1 }),
    ),
    Mount.resolve(
      Combobox.AttachComboboxPreventBlur,
      Combobox.Message.CompletedAttachComboboxPreventBlur(),
    ),
    Mount.resolve(
      Combobox.AttachComboboxSelectOnFocus,
      Combobox.Message.CompletedAttachComboboxSelectOnFocus(),
    ),
    expect(label("Model")).toHaveValue("Reasoning model"),
    expect(label("Reasoning effort")).toHaveValue("high"),
    type(label("Model"), "no-such-model"),
    expect(text("No matching models.")).toBeVisible(),
    type(label("Model"), "plain"),
    Mount.resolve(Combobox.AnchorCombobox, Combobox.Message.CompletedAnchorCombobox()),
    Mount.resolve(
      Combobox.PortalComboboxBackdrop,
      Combobox.Message.CompletedPortalComboboxBackdrop(),
    ),
    expect(role("button", { name: "Conversation settings" })).toHaveAttr("aria-expanded", "true"),
    expect(role("option", { name: "Plain model" })).toBeVisible(),
    expect(role("option", { name: "Reasoning model" })).not.toExist(),
    click(role("option", { name: "Plain model" })),
    Command.resolve(Combobox.FocusInput, Combobox.Message.CompletedFocusInput()),
    Mount.expectEnded(Combobox.PortalComboboxBackdrop, Combobox.AnchorCombobox),
    Command.expectExact(
      ConfigureSession({
        settings: ModelSettings.make({ model: "plain-model", thinkingLevel: "off" }),
      }),
    ),
    expect(label("Model")).toBeDisabled(),
    expect(label("Reasoning effort")).toBeDisabled(),
    expect(role("button", { name: "Send message" })).toBeDisabled(),

    Command.resolve(ConfigureSession, Message.CompletedConfigureSession({ requestId })),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(ready, {
          maybeAcknowledgedRequestId: () => Option.some(requestId),
          chat: (chat) =>
            modifyFields(chat, { model: () => "plain-model", thinkingLevel: () => "off" }),
        }),
      }),
    ),
    expect(label("Model")).toHaveValue("Plain model"),
    expect(label("Reasoning effort")).toHaveValue("off"),
    expect(label("Reasoning effort")).toBeDisabled(),
    expect(label("Message Pi")).toHaveValue("Keep my draft"),
    expect(role("button", { name: "Send message" })).toBeEnabled(),
    Subscription.emit(
      Message.UpdatedWorkflow({ workflow: modifyFields(ready, { phase: () => "waiting" }) }),
    ),
    expect(label("Model")).toBeDisabled(),
    expect(label("Reasoning effort")).toBeDisabled(),
  );
});

test("uncertain settings expose refresh beside the feedback without opening workspace options", () => {
  const uncertain = modifyFields(init().model, {
    draft: () => "Keep my draft",
    workflow: (workflow) =>
      modifyFields(workflow, {
        phase: () => "settingsFailed",
        maybeError: () => Option.some("Could not confirm settings."),
      }),
  });
  scene(
    { update, view },
    given(uncertain),
    expect(role("alert")).toBeVisible(),
    expect(role("button", { name: "Refresh" })).toBeEnabled(),
    expect(role("button", { name: "Send message" })).toBeDisabled(),
    expect(label("Message Pi")).toHaveValue("Keep my draft"),
  );
});
