import * as Option from "effect/Option";
import {
  ChevronDown,
  Plus,
  Pencil,
  Archive,
  ArchiveRestore,
  GitFork,
  BookOpen,
  Download,
} from "lucide";
import type { HtmlBuilder } from "foldkit/html";
import { MAX_MEMORY_LENGTH } from "../model.ts";
import { Message } from "./message.ts";
import { canSelectSession, selectedSessionTitle, type Model } from "./model.ts";
import { icon } from "./lib/icons.ts";
import { button, buttonClass } from "./components/ui/button.ts";
import { input } from "./components/ui/input.ts";
import { textarea } from "./components/ui/textarea.ts";
import * as Popover from "./components/ui/popover.ts";
import * as Dialog from "./components/ui/dialog.ts";

export const threadSwitcherView = (model: Model, h: HtmlBuilder<Message>) => {
  const sessions = model.workspace.sessions.filter(
    (session) =>
      session.archived === (model.threadFilter === "archived") &&
      session.title.toLowerCase().includes(model.threadQuery.trim().toLowerCase()),
  );
  return h.div(
    [h.Class("flex min-w-0 items-center gap-1")],
    [
      h.h1([h.Class("sr-only")], ["Pi"]),
      h.submodel({
        slotId: "threads",
        model: model.threadPopover,
        view: Popover.view,
        toParentMessage: (message) => Message.GotThreadPopoverMessage({ message }),
        viewInputs: Popover.styledViewInputs(
          {
            ariaLabel: "Switch thread",
            focusSelector: "#thread-search",
            isDisabled: !canSelectSession(model),
            anchor: { placement: "bottom-start", gap: 6, padding: 12 },
            wrapperClass: "min-w-0",
            trigger: h.span(
              [h.Class("flex min-w-0 items-center gap-1.5")],
              [
                h.span(
                  [h.Class("truncate text-sm font-semibold sm:text-base")],
                  [selectedSessionTitle(model)],
                ),
                icon(h, ChevronDown, "size-3.5 shrink-0"),
              ],
            ),
            triggerClass: buttonClass({
              variant: "ghost",
              className: "min-h-11 max-w-[min(52vw,24rem)] min-w-0 justify-start px-2",
            }),
            contentClass:
              "w-80 max-w-[calc(100vw-1.5rem)] border border-border bg-card text-foreground",
            content: [
              input(
                {
                  id: "thread-search",
                  label: "Search threads",
                  labelClass: "sr-only",
                  type: "search",
                  placeholder: "Search threads…",
                  value: model.threadQuery,
                  onInput: (value) => Message.UpdatedThreadQuery({ value }),
                  className: "min-h-11 text-base md:text-base",
                },
                h,
              ),
              h.div(
                [h.Class("flex gap-1"), h.Role("group"), h.AriaLabel("Thread filter")],
                (["active", "archived"] as const).map((value) =>
                  button(
                    {
                      type: "button",
                      variant: model.threadFilter === value ? "secondary" : "ghost",
                      className: "min-h-11 flex-1",
                      onClick: Message.SelectedThreadFilter({ value }),
                      attributes: [h.AriaPressed(model.threadFilter === value ? "true" : "false")],
                    },
                    value === "active" ? "Active" : "Archived",
                    h,
                  ),
                ),
              ),
              h.div(
                [
                  h.Class("max-h-[min(24rem,55dvh)] overflow-y-auto overscroll-contain"),
                  h.AriaLabel("Threads"),
                ],
                sessions.length
                  ? sessions.map((session) =>
                      h.keyed("div")(
                        session.id,
                        [h.Class("flex items-center rounded-lg hover:bg-muted")],
                        [
                          button(
                            {
                              type: "button",
                              variant: "ghost",
                              className: "min-h-11 min-w-0 flex-1 justify-start px-2 text-left",
                              onClick: Message.SelectedSession({ sessionId: session.id }),
                              attributes: [
                                h.AriaCurrent(
                                  session.id === model.workflow.sessionId ? "true" : "false",
                                ),
                              ],
                            },
                            [
                              h.span([h.Class("min-w-0 truncate")], [session.title]),
                              session.busy ||
                              (session.id === model.workflow.sessionId &&
                                ["waiting", "waitFailed", "stopping"].includes(
                                  model.workflow.phase,
                                ))
                                ? h.span(
                                    [h.Class("ml-auto shrink-0 text-xs text-muted-foreground")],
                                    ["Working"],
                                  )
                                : h.empty,
                            ],
                            h,
                          ),
                          button(
                            {
                              type: "button",
                              variant: "ghost",
                              className: "size-11 shrink-0",
                              isDisabled: model.workspaceActivity !== "idle",
                              onClick: Message.ClickedRenameThread({ sessionId: session.id }),
                              attributes: [h.AriaLabel(`Rename ${session.title}`)],
                            },
                            icon(h, Pencil),
                            h,
                          ),
                          button(
                            {
                              type: "button",
                              variant: "ghost",
                              className: "size-11 shrink-0",
                              isDisabled: model.workspaceActivity !== "idle" || session.busy,
                              onClick: Message.ClickedArchiveThread({ sessionId: session.id }),
                              attributes: [
                                h.AriaLabel(
                                  `${session.archived ? "Restore" : "Archive"} ${session.title}`,
                                ),
                              ],
                            },
                            icon(h, session.archived ? ArchiveRestore : Archive),
                            h,
                          ),
                        ],
                      ),
                    )
                  : [
                      h.p(
                        [
                          h.Class("px-2 py-5 text-center text-sm text-muted-foreground"),
                          h.Role("status"),
                        ],
                        [
                          model.workspaceActivity === "loading"
                            ? "Loading threads…"
                            : model.threadQuery
                              ? "No matching threads."
                              : model.threadFilter === "archived"
                                ? "No archived threads."
                                : "Your threads will appear here.",
                        ],
                      ),
                    ],
              ),
              Option.match(model.maybeWorkspaceError, {
                onNone: () => h.empty,
                onSome: (error) =>
                  h.p([h.Class("px-2 text-sm text-destructive"), h.Role("alert")], [error]),
              }),
              model.workspaceActivity === "createFailed"
                ? button(
                    {
                      type: "button",
                      variant: "outline",
                      className: "min-h-11",
                      onClick: Message.ClickedRetryCreateThread(),
                    },
                    "Retry creating thread",
                    h,
                  )
                : h.empty,
            ],
          },
          h,
        ),
      }),
      button(
        {
          type: "button",
          variant: "ghost",
          className: "size-11 shrink-0 text-muted-foreground",
          isDisabled: !canSelectSession(model) || model.workspaceActivity !== "idle",
          onClick: Message.ClickedNewThread(),
          attributes: [h.AriaLabel("New thread"), h.Title("New thread")],
        },
        icon(h, Plus),
        h,
      ),
    ],
  );
};

export const workspaceActionsView = (model: Model, h: HtmlBuilder<Message>) => [
  button(
    {
      type: "button",
      variant: "ghost",
      className: "min-h-11 w-full justify-start",
      isDisabled: model.workspaceActivity === "loading",
      onClick: Message.ClickedSharedMemory(),
    },
    [icon(h, BookOpen), "Shared memory"],
    h,
  ),
  button(
    {
      type: "button",
      variant: "ghost",
      className: "min-h-11 w-full justify-start",
      isDisabled: !canSelectSession(model) || model.workspaceActivity !== "idle",
      onClick: Message.ClickedForkThread(),
    },
    [icon(h, GitFork), "Fork this thread"],
    h,
  ),
  button(
    {
      type: "button",
      variant: "ghost",
      className: "min-h-11 w-full justify-start",
      isDisabled: model.workflow.chat.messages.length === 0,
      onClick: Message.ClickedExportConversation(),
    },
    [icon(h, Download), "Export Markdown"],
    h,
  ),
];

export const memoryDialogView = (model: Model, h: HtmlBuilder<Message>) =>
  h.submodel({
    slotId: "shared-memory",
    model: model.memoryDialog,
    view: Dialog.view,
    toParentMessage: (message) => Message.GotMemoryDialogMessage({ message }),
    viewInputs: Dialog.styledViewInputs(
      {
        hasDescription: true,
        panelClass:
          "w-[calc(100%-2rem)] max-w-lg max-h-[85dvh] overflow-y-auto border border-border bg-card text-foreground",
        content: (render) => [
          Dialog.header(
            {},
            [
              Dialog.title({ attributes: render.title }, ["Shared memory"], h),
              Dialog.description(
                { attributes: render.description },
                [
                  "Things you want Pi to remember across every thread. Changes apply to future messages.",
                ],
                h,
              ),
            ],
            h,
          ),
          textarea(
            {
              id: "shared-memory-text",
              label: "Memory",
              value: model.memoryDraft,
              onInput: (value) => Message.UpdatedMemoryDraft({ value }),
              rows: 9,
              placeholder: "Preferences, useful context, and standing instructions…",
              isDisabled: model.memorySaveState === "saving",
              isInvalid: model.memoryDraft.length > MAX_MEMORY_LENGTH,
              className: "min-h-40 resize-y text-base md:text-base",
              description: `${model.memoryDraft.length.toLocaleString()} / ${MAX_MEMORY_LENGTH.toLocaleString()} characters`,
            },
            h,
          ),
          Option.match(model.maybeMemoryError, {
            onNone: () => h.empty,
            onSome: (error) => h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [error]),
          }),
          model.memorySaveState === "conflict"
            ? h.div(
                [h.Class("grid gap-2")],
                [
                  h.p(
                    [h.Class("text-sm text-muted-foreground")],
                    [
                      "Your edits are kept. Load the latest saved memory, review it, then save your changes again.",
                    ],
                  ),
                  button(
                    {
                      type: "button",
                      variant: "outline",
                      className: "min-h-11",
                      onClick: Message.ClickedReloadMemory(),
                      isDisabled: model.workspaceActivity === "loading",
                    },
                    "Load latest memory",
                    h,
                  ),
                ],
              )
            : h.empty,
          model.memoryRevision !== model.workspace.memory.revision
            ? h.div(
                [h.Class("rounded-lg border border-border p-3")],
                [
                  h.p(
                    [h.Class("mb-2 text-xs font-medium text-muted-foreground")],
                    ["Latest saved memory"],
                  ),
                  h.p(
                    [h.Class("max-h-36 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm")],
                    [model.workspace.memory.text || "No saved memory."],
                  ),
                ],
              )
            : h.empty,
          Dialog.footer(
            {},
            [
              Dialog.closeButton(
                {
                  attributes: render.closeButton,
                  className: buttonClass({
                    variant: "outline",
                    className: "static min-h-11 h-auto w-auto px-4",
                  }),
                },
                ["Cancel"],
                h,
              ),
              button(
                {
                  type: "button",
                  className: "min-h-11",
                  isDisabled:
                    model.workspaceActivity !== "idle" ||
                    model.memorySaveState === "saving" ||
                    model.memorySaveState === "conflict" ||
                    model.memoryDraft.length > MAX_MEMORY_LENGTH,
                  onClick: Message.ClickedSaveMemory(),
                },
                model.memorySaveState === "saving"
                  ? "Saving…"
                  : model.memorySaveState === "review"
                    ? "Save my changes"
                    : "Save memory",
                h,
              ),
            ],
            h,
          ),
        ],
      },
      h,
    ),
  });
export const renameDialogView = (model: Model, h: HtmlBuilder<Message>) =>
  h.submodel({
    slotId: "rename-thread",
    model: model.renameDialog,
    view: Dialog.view,
    toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
    viewInputs: Dialog.styledViewInputs(
      {
        panelClass: "w-[calc(100%-2rem)] max-w-sm border border-border bg-card text-foreground",
        content: (render) => [
          Dialog.title({ attributes: render.title }, ["Name this thread"], h),
          h.form(
            [h.OnSubmit(Message.SubmittedRenameThread()), h.Class("grid gap-4")],
            [
              input(
                {
                  id: "thread-name",
                  label: "Thread name",
                  labelClass: "sr-only",
                  value: model.renameDraft,
                  onInput: (value) => Message.UpdatedRenameDraft({ value }),
                  isInvalid: model.renameDraft.trim().length > 120,
                  className: "min-h-11 text-base md:text-base",
                },
                h,
              ),
              Option.match(model.maybeWorkspaceError, {
                onNone: () => h.empty,
                onSome: (error) =>
                  h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [error]),
              }),
              Dialog.footer(
                {},
                [
                  Dialog.closeButton(
                    {
                      attributes: render.closeButton,
                      className: buttonClass({
                        variant: "outline",
                        className: "static min-h-11 h-auto w-auto px-4",
                      }),
                    },
                    ["Cancel"],
                    h,
                  ),
                  button(
                    {
                      type: "submit",
                      className: "min-h-11",
                      isDisabled:
                        !model.renameDraft.trim() ||
                        model.renameDraft.trim().length > 120 ||
                        model.workspaceActivity !== "idle",
                    },
                    model.workspaceActivity === "mutating" ? "Saving…" : "Save name",
                    h,
                  ),
                ],
                h,
              ),
            ],
          ),
        ],
      },
      h,
    ),
  });
