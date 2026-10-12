import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { createLazy, type Document, type HtmlBuilder } from "foldkit/html";
import { Check, ArrowUp, ChevronDown, Ellipsis, RefreshCw, Copy, Square } from "lucide";
import { icon } from "./lib/icons.ts";
import * as Combobox from "./components/ui/combobox.ts";
import * as Popover from "./components/ui/popover.ts";
import { buttonClass } from "./components/ui/button.ts";
import { button } from "@/components/ui/button";
import { textarea } from "@/components/ui/textarea";
import { nativeSelect, nativeSelectOption } from "@/components/ui/native-select";
import { MAX_PROMPT_LENGTH, type ChatState, type Submission } from "../model.ts";
import { Message } from "./message.ts";
import {
  selectedSession,
  canStop,
  canSubmit,
  canRefresh,
  canRetry,
  canConfigure,
  ModelCombobox,
  selectedModelName,
  type Model,
} from "./model.ts";
import { renderMessageMarkdown } from "./markdown.ts";
import {
  threadSwitcherView,
  workspaceActionsView,
  memoryDialogView,
  renameDialogView,
} from "./workspace-view.ts";
import type { WorkflowView } from "./workflow.ts";

const headerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.header(
    [h.Class("flex h-14 shrink-0 items-center justify-between")],
    [
      threadSwitcherView(model, h),
      h.submodel({
        slotId: "workspace",
        model: model.workspacePopover,
        view: Popover.view,
        viewInputs: Popover.styledViewInputs(
          {
            anchor: { placement: "bottom-end", gap: 6, padding: 12 },
            ariaLabel: "Workspace options",
            focusSelector: "#refresh-conversation",
            trigger: h.span(
              [],
              [icon(h, Ellipsis), h.span([h.Class("sr-only")], ["Workspace options"])],
            ),
            triggerClass: buttonClass({
              variant: "ghost",
              className: "size-11 rounded-full text-muted-foreground",
            }),
            contentClass: `w-64 max-w-[calc(100vw-1.5rem)] border border-border bg-card p-3 text-foreground ${Option.isSome(model.workspacePopover.maybeLastButtonPointerType) ? "popover-motion" : ""}`,
            content: [
              ...workspaceActionsView(model, h),
              h.p(
                [h.Class("px-2 py-1 text-xs text-muted-foreground")],
                [
                  model.workflow.chat.connection === "connected"
                    ? "ChatGPT connected"
                    : "ChatGPT not connected",
                ],
              ),
              button(
                {
                  variant: "ghost",
                  type: "button",
                  isDisabled: !canRefresh(model),
                  onClick: Message.ClickedRefresh(),
                  attributes: [h.Id("refresh-conversation")],
                  className: "min-h-11 w-full justify-start",
                },
                [icon(h, RefreshCw), "Refresh conversation"],
                h,
              ),
              h.p(
                [h.Class("px-2 py-1 text-xs leading-relaxed text-muted-foreground")],
                ["Your conversation is saved. Pi keeps working when you close this page."],
              ),
            ],
          },
          h,
        ),
        toParentMessage: (message) => Message.GotWorkspacePopoverMessage({ message }),
      }),
    ],
  );
const emptyConversationView = (h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex flex-1 flex-col justify-center gap-2 px-1 py-8")],
    [
      h.h2([h.Class("text-2xl font-medium tracking-tight sm:text-3xl")], ["What’s on your mind?"]),
      h.p(
        [h.Class("text-sm leading-relaxed text-muted-foreground")],
        ["Ask a question or work through an idea."],
      ),
    ],
  );
const messageView = (
  message: ChatState["messages"][number],
  maybeCopiedMessage: Option.Option<string>,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("article")(
    message.id,
    [h.AriaLabel(message.role === "user" ? "Your message" : "Pi's reply")],
    [
      h.div(
        [
          h.Class(
            message.role === "user"
              ? "ml-auto w-fit max-w-[90%] wrap-anywhere whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed"
              : "max-w-full wrap-anywhere px-1 text-sm leading-relaxed",
          ),
        ],
        [message.role === "assistant" ? renderMessageMarkdown(message.text, h) : message.text],
      ),
      message.role === "assistant" && Option.exists(maybeCopiedMessage, (id) => id === message.id)
        ? h.span([h.Role("status"), h.AriaLive("polite"), h.Class("sr-only")], ["Reply copied"])
        : h.empty,
      message.role === "assistant"
        ? button(
            {
              type: "button",
              variant: "ghost",
              className: "min-h-11 px-2 text-xs text-muted-foreground",
              onClick: Message.ClickedCopyReply({ messageId: message.id, text: message.text }),
              attributes: [h.AriaLabel("Copy reply")],
            },
            [
              icon(h, Copy, "size-3.5"),
              Option.exists(maybeCopiedMessage, (id) => id === message.id) ? "Copied" : "Copy",
            ],
            h,
          )
        : h.empty,
    ],
  );
// NOTE: Only the viewport reverses; message DOM order remains chronological.
// Native scroll anchoring follows the end and preserves an older reading position.
const lazyTranscriptContent = createLazy();
const transcriptContentView = (
  messages: ChatState["messages"],
  maybeSubmission: Option.Option<Submission>,
  maybeCopiedMessage: Option.Option<string>,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex min-h-full shrink-0 flex-col gap-5 py-4 sm:py-6")],
    [
      ...Array.match(messages, {
        onEmpty: () => (Option.isNone(maybeSubmission) ? [emptyConversationView(h)] : []),
        onNonEmpty: (messages) =>
          messages.map((message) => messageView(message, maybeCopiedMessage, h)),
      }),
      Option.match(maybeSubmission, {
        onNone: () => h.empty,
        onSome: (submission) =>
          messageView(
            { id: submission.operationId, role: "user", text: submission.prompt },
            maybeCopiedMessage,
            h,
          ),
      }),
    ],
  );
const transcriptView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      h.Class(
        "flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-ring",
      ),
      h.AriaLabel("Conversation"),
      h.Tabindex(0),
    ],
    [
      lazyTranscriptContent(transcriptContentView, [
        model.workflow.chat.messages,
        model.workflow.phase === "submitRejected" ? Option.none() : model.workflow.maybeSubmission,
        model.maybeCopiedMessage,
        h,
      ]),
    ],
  );
const statusText = (phase: WorkflowView["phase"]) =>
  ({
    loading: "Opening your conversation…",
    ready: "",
    submitting: "Sending…",
    waiting: "Pi is working…",
    loadFailed: "Connection interrupted",
    submitRejected: "This message was not accepted",
    submitFailed: "Message delivery uncertain",
    waitFailed: "Reconnecting is safe; your task may still be running.",
    configuring: "Saving settings…",
    settingsFailed: "Refresh to confirm your settings",
    reconciling: "Checking the saved conversation…",
    reconcileFailed: "Could not confirm the saved conversation",
    stopping: "Stopping…",
    stopFailed: "Refresh to confirm the task stopped",
  })[phase];
const workflowStatusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("shrink-0")],
    [
      h.div(
        [
          h.Class(
            "flex items-center justify-between gap-3 text-sm text-muted-foreground empty:hidden",
          ),
          h.AriaLive("polite"),
        ],
        [
          model.workflow.phase === "ready"
            ? h.empty
            : h.span([h.Class("py-2")], [statusText(model.workflow.phase)]),
          ["settingsFailed", "stopFailed", "reconcileFailed"].includes(model.workflow.phase)
            ? button(
                {
                  onClick: Message.ClickedRefresh(),
                  variant: "outline",
                  type: "button",
                  isDisabled: !canRefresh(model),
                  className: "min-h-11",
                },
                "Refresh",
                h,
              )
            : canRetry(model)
              ? button(
                  {
                    onClick: Message.ClickedRetry(),
                    variant: "outline",
                    type: "button",
                    className: "min-h-11",
                  },
                  "Retry",
                  h,
                )
              : h.empty,
        ],
      ),
      Option.match(
        Option.orElse(
          Option.orElse(model.maybeFeedback, () => model.workflow.maybeError),
          () => model.maybeWorkspaceError,
        ),
        {
          onNone: () => h.empty,
          onSome: (error) =>
            h.p(
              [
                h.Class(
                  "feedback-notice mb-2 rounded-xl border border-destructive/30 bg-card p-3 text-sm text-destructive",
                ),
                h.Role("alert"),
              ],
              [error],
            ),
        },
      ),
      model.workspaceActivity === "createFailed"
        ? button(
            {
              type: "button",
              variant: "outline",
              className: "mb-2 min-h-11",
              onClick: Message.ClickedRetryCreateThread(),
            },
            "Retry creating thread",
            h,
          )
        : h.empty,
      model.workflow.phase === "ready" && model.workflow.chat.connection === "missing"
        ? h.p(
            [h.Class("mb-2 text-sm text-muted-foreground")],
            [
              "ChatGPT is not connected. Reconnect the app’s ChatGPT account, then refresh this conversation.",
            ],
          )
        : h.empty,
    ],
  );
const settingsView = (model: Model, h: HtmlBuilder<Message>) => {
  const chat = model.workflow.chat;
  const selected = chat.models.find((choice) => choice.id === chat.model);
  const name = selectedModelName(chat);
  const query =
    model.modelCombobox.inputValue === name
      ? ""
      : model.modelCombobox.inputValue.trim().toLowerCase();
  const matches = chat.models.filter((choice) =>
    `${choice.name} ${choice.id}`.toLowerCase().includes(query),
  );
  return h.div(
    [h.Class("grid gap-4"), h.Role("group"), h.AriaLabel("Conversation settings")],
    [
      h.div(
        [h.Class("grid gap-1.5")],
        [
          h.label(
            [h.For(Combobox.inputId(model.modelCombobox.id)), h.Class("text-sm font-medium")],
            ["Model"],
          ),
          h.submodel({
            slotId: "model-picker",
            model: model.modelCombobox,
            view: ModelCombobox.view,
            viewInputs: Combobox.viewInputs({
              items: matches.map((choice) => choice.id),
              maybeSelectedValue: Option.some(chat.model),
              restingInputValue: name,
              itemToValue: (value) => value,
              itemToDisplayText: (value) =>
                chat.models.find((choice) => choice.id === value)?.name ?? value,
              itemToConfig: (value, context) => ({
                content: h.span(
                  [h.Class("flex min-w-0 items-center gap-2")],
                  [
                    icon(
                      h,
                      Check,
                      context.isSelected ? "size-4 shrink-0" : "invisible size-4 shrink-0",
                    ),
                    h.span(
                      [h.Class("wrap-anywhere")],
                      [chat.models.find((choice) => choice.id === value)?.name ?? value],
                    ),
                  ],
                ),
              }),
              isDisabled: !canConfigure(model) || Array.isReadonlyArrayEmpty(chat.models),
              openOnFocus: false,
              inputPlaceholder: "Search models…",
              buttonContent: Combobox.comboboxChevron(h),
              inputClass: "min-h-11 text-base md:text-base",
              itemsClass: "border border-border bg-card text-foreground",
              itemsScrollClass: "max-h-64 overflow-y-auto overscroll-contain p-1",
              itemClass: "min-h-11 px-2 data-active:bg-muted data-active:text-foreground",
              anchor: { placement: "top-start", gap: 6, padding: 12 },
            }),
            toParentMessage: (message) => Message.GotModelComboboxMessage({ message }),
          }),
          model.modelCombobox.isOpen && Array.isReadonlyArrayEmpty(matches)
            ? h.p(
                [h.Class("text-sm text-muted-foreground"), h.Role("status")],
                ["No matching models."],
              )
            : h.empty,
        ],
      ),
      nativeSelect(
        {
          id: "reasoning",
          label: "Reasoning effort",
          value: chat.thinkingLevel,
          onChange: (value) => Message.SelectedThinkingLevel({ value }),
          isDisabled: !canConfigure(model) || !selected || selected.thinkingLevels.length < 2,
          className: "min-h-11 w-full text-base",
          wrapperClass: "min-w-0 [&_[data-slot=native-select-wrapper]]:w-full",
          options: (selected?.thinkingLevels ?? [chat.thinkingLevel]).map((level) =>
            nativeSelectOption(
              {
                value: level,
                label: {
                  off: "Off",
                  minimal: "Minimal",
                  low: "Low",
                  medium: "Medium",
                  high: "High",
                  xhigh: "Extra high",
                  max: "Maximum",
                }[level],
              },
              h,
            ),
          ),
        },
        h,
      ),
    ],
  );
};
const settingsPopoverView = (model: Model, h: HtmlBuilder<Message>) => {
  const chat = model.workflow.chat;
  const name = selectedModelName(chat);
  return h.submodel({
    slotId: "settings",
    model: model.settingsPopover,
    view: Popover.view,
    viewInputs: Popover.styledViewInputs(
      {
        anchor: { placement: "top-start", gap: 10, padding: 12 },
        ariaLabel: "Conversation settings",
        focusSelector: "#model-input",
        isEscapeEnabled: !model.modelCombobox.isOpen,
        trigger: h.span(
          [h.Class("flex min-w-0 items-center gap-1.5")],
          [
            h.span([h.Class("sr-only")], ["Model and reasoning: "]),
            h.span([h.Class("truncate")], [name || "Loading…"]),
            h.span([h.Class("shrink-0 text-muted-foreground")], [`· ${chat.thinkingLevel}`]),
            icon(h, ChevronDown, "size-3.5 shrink-0"),
          ],
        ),
        triggerClass: buttonClass({
          variant: "ghost",
          className:
            "min-h-11 max-w-full min-w-0 justify-start rounded-xl px-2 text-xs text-muted-foreground",
        }),
        wrapperClass: "min-w-0 max-w-full",
        contentClass: `w-80 max-w-[calc(100vw-1.5rem)] border border-border bg-card p-4 text-foreground ${Option.isSome(model.settingsPopover.maybeLastButtonPointerType) ? "popover-motion" : ""}`,
        content: [settingsView(model, h)],
      },
      h,
    ),
    toParentMessage: (message) => Message.GotSettingsPopoverMessage({ message }),
  });
};
const composerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.form(
    [
      h.AriaLabel("Send a message"),
      h.OnSubmit(Message.SubmittedPrompt()),
      h.Class("group/composer shrink-0 rounded-2xl border border-border bg-card p-2 shadow-sm"),
    ],
    [
      textarea(
        {
          id: "prompt",
          label: "Message Pi",
          isRequired: true,
          labelClass: "sr-only",
          value: model.draft,
          onInput: (value) => Message.UpdatedDraft({ value }),
          placeholder: "Message Pi…",
          rows: 1,
          wrapperClass: "gap-0",
          className:
            "min-h-11 max-h-[min(12rem,30dvh)] resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 text-base md:text-base shadow-none focus-visible:ring-2",
          isInvalid: model.draft.length > MAX_PROMPT_LENGTH,
          description:
            model.draft.length > MAX_PROMPT_LENGTH
              ? `Remove ${(model.draft.length - MAX_PROMPT_LENGTH).toLocaleString()} ${model.draft.length === MAX_PROMPT_LENGTH + 1 ? "character" : "characters"} to send this message.`
              : "Enter for a new line · ⌘/Ctrl + Enter to send",
          descriptionClass:
            model.draft.length > MAX_PROMPT_LENGTH
              ? "px-3 py-1 text-xs text-destructive"
              : "sr-only",
          isDisabled: model.dispatch._tag !== "Idle",
        },
        h,
      ),
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          settingsPopoverView(model, h),
          h.div(
            [h.Class("flex shrink-0 items-center gap-2")],
            [
              model.draft.length >= MAX_PROMPT_LENGTH * 0.9
                ? h.span(
                    [h.Class("text-xs tabular-nums text-muted-foreground")],
                    [
                      `${model.draft.length.toLocaleString()} / ${MAX_PROMPT_LENGTH.toLocaleString()}`,
                    ],
                  )
                : h.empty,
              canStop(model) || model.workflow.phase === "stopping"
                ? button(
                    {
                      type: "button",
                      variant: "outline",
                      className: "min-h-11 rounded-xl px-3",
                      isDisabled: !canStop(model),
                      onClick: Message.ClickedStop(),
                      attributes: [h.AriaLabel("Stop response")],
                    },
                    [icon(h, Square, "size-4"), "Stop"],
                    h,
                  )
                : button(
                    {
                      type: "submit",
                      isDisabled: !canSubmit(model),
                      className: "size-11 rounded-xl",
                      attributes: [
                        h.AriaLabel("Send message"),
                        h.Title("Send message (⌘/Ctrl + Enter)"),
                      ],
                    },
                    icon(h, ArrowUp, "size-5"),
                    h,
                  ),
            ],
          ),
        ],
      ),
    ],
  );

/** Accessible foldcn controls over the official Foldkit UI primitives. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Pi · Personal assistant",
  body: h.main(
    [h.Class("app-shell mx-auto flex h-dvh min-h-0 w-full max-w-3xl flex-col")],
    [
      headerView(model, h),
      transcriptView(model, h),
      workflowStatusView(model, h),
      selectedSession(model)?.archived
        ? h.div(
            [h.Class("flex items-center justify-between gap-2 py-2 text-sm text-muted-foreground")],
            [
              h.span([], ["This thread is archived."]),
              button(
                {
                  type: "button",
                  variant: "outline",
                  className: "min-h-11",
                  isDisabled: model.workspaceActivity !== "idle",
                  onClick: Message.ClickedArchiveThread({ sessionId: model.workflow.sessionId }),
                },
                "Restore thread",
                h,
              ),
            ],
          )
        : h.empty,
      composerView(model, h),
      memoryDialogView(model, h),
      renameDialogView(model, h),
    ],
  ),
});
