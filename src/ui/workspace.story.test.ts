import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { CreateSession, ROOT_SESSION, SessionId, OperationId } from "../model.ts";
import { Popover } from "@foldkit/ui";
import { init, Message, update, StopWorkflow, RefreshWorkflow } from "./main.ts";
import { canSubmit, canSelectSession, type Model } from "./model.ts";
import {
  CreateThread,
  SaveMemory,
  SelectSession,
  PrepareThread,
  ExportConversation,
  LoadWorkspace,
} from "./workspace.ts";
import { selectedThreadFromUrl, workspaceRouter } from "./navigation.ts";

const other = SessionId.make("2");
const requestId = OperationId.make("workspace-request-123");
const readyModel = (): Model =>
  modifyFields(init().model, {
    workspaceActivity: () => "idle",
    workspace: () => ({
      sessions: [
        { id: ROOT_SESSION, title: "Original", archived: false, busy: false },
        { id: other, title: "Second", archived: false, busy: false },
      ],
      memory: { text: "Saved context", revision: 1 },
    }),
    workflow: (workflow) =>
      modifyFields(workflow, {
        phase: () => "ready",
        chat: (chat) => modifyFields(chat, { connection: () => "connected" }),
      }),
  });

test("drafts survive switching threads; a late acknowledgement cannot clear another thread or lock it", () => {
  const first = update(readyModel(), Message.UpdatedDraft({ value: "Original draft" })).model;
  story(
    update,
    given(first),
    message(Message.SelectedSession({ sessionId: other })),
    Command.expectExact(SelectSession({ sessionId: other })),
    Command.resolve(SelectSession, Message.FailedWorkflowRequest()),
  );
  const second = update(
    first,
    Message.UpdatedWorkflow({ workflow: modifyFields(first.workflow, { sessionId: () => other }) }),
  ).model;
  expect(second.draft).toBe("");
  const composing = update(second, Message.UpdatedDraft({ value: "Second draft" })).model;
  const late = update(
    composing,
    Message.CompletedSubmitPrompt({ requestId, sessionId: ROOT_SESSION }),
  ).model;
  expect(late).toEqual(composing);
  const returned = update(late, Message.UpdatedWorkflow({ workflow: first.workflow })).model;
  expect(returned.draft).toBe("Original draft");
  expect(returned.drafts[other]).toBe("Second draft");
});

test("uncertain creation retry uses the original durable operation id", () => {
  const input = CreateSession.make({ operationId: requestId, title: "" });
  story(
    update,
    given(readyModel()),
    message(Message.CompletedPrepareThread({ input })),
    Command.resolve(CreateThread, Message.FailedCreateThread({ error: "Delivery uncertain" })),
    message(Message.ClickedRetryCreateThread()),
    Command.expectExact(CreateThread({ input })),
    model((value) => expect(Option.getOrNull(value.maybeCreation)).toEqual(input)),
    Command.resolve(CreateThread, Message.FailedCreateThread({ error: "Still uncertain" })),
  );
});

test("failed memory saves preserve dirty text and revision; conflicts require reviewing latest context", () => {
  const editing = modifyFields(readyModel(), {
    memoryDraft: () => "My edits",
    memoryRevision: () => 1,
  });
  story(
    update,
    given(editing),
    message(Message.ClickedSaveMemory()),
    Command.expectExact(SaveMemory({ text: "My edits", revision: 1 })),
    Command.resolve(
      SaveMemory,
      Message.FailedSaveMemory({ error: "Memory changed elsewhere", conflict: true }),
    ),
    model((value) => {
      expect(value.memoryDraft).toBe("My edits");
      expect(value.memoryRevision).toBe(1);
      expect(update(value, Message.ClickedSaveMemory()).model).toEqual(value);
    }),
    message(
      Message.CompletedLoadWorkspace({
        generation: editing.workspaceGeneration + 1,
        workspace: {
          sessions: editing.workspace.sessions,
          memory: { text: "Other changes", revision: 2 },
        },
      }),
    ),
    model((value) => expect(value.memoryDraft).toBe("My edits")),
    message(Message.ClickedSaveMemory()),
    Command.expectExact(SaveMemory({ text: "My edits", revision: 2 })),
    Command.resolve(
      SaveMemory,
      Message.FailedSaveMemory({ error: "Unavailable", conflict: false }),
    ),
  );
});

test("accepted work allows thread navigation while uncertain mutations do not; stop locks duplicate requests", () => {
  const waiting: Model = modifyFields(readyModel(), {
    workflow: (workflow) => modifyFields(workflow, { phase: () => "waiting" }),
  });
  expect(canSelectSession(waiting)).toBe(true);
  story(
    update,
    given(waiting),
    message(Message.ClickedStop()),
    Command.expectExact(StopWorkflow()),
    model((value) => {
      expect(value.dispatch._tag).toBe("Preparing");
      expect(update(value, Message.ClickedStop()).model).toEqual(value);
      expect(update(value, Message.SelectedSession({ sessionId: other })).model).toEqual(value);
    }),
    Command.resolve(StopWorkflow, Message.FailedWorkflowRequest()),
  );
  expect(
    canSelectSession(
      modifyFields(waiting, {
        workflow: (workflow) => modifyFields(workflow, { phase: () => "submitFailed" }),
      }),
    ),
  ).toBe(false);
});

test("archiving prevents new submissions and restoring re-enables them", () => {
  const draft = modifyFields(readyModel(), { draft: () => "A message" });
  expect(canSubmit(draft)).toBe(true);
  const archived = update(
    draft,
    Message.CompletedUpdateThread({
      workspace: {
        sessions: draft.workspace.sessions.map((session) =>
          session.id === ROOT_SESSION ? modifyFields(session, { archived: () => true }) : session,
        ),
        memory: draft.workspace.memory,
      },
    }),
  ).model;
  expect(canSubmit(archived)).toBe(false);
  const restored = update(
    archived,
    Message.CompletedUpdateThread({ workspace: draft.workspace }),
  ).model;
  expect(canSubmit(restored)).toBe(true);
});

test("selected thread URLs round-trip and reject invalid identifiers", () => {
  expect(
    Option.getOrNull(
      selectedThreadFromUrl(`https://pi.example${workspaceRouter({ thread: Option.some(other) })}`),
    ),
  ).toBe(other);
  expect(Option.isNone(selectedThreadFromUrl("https://pi.example/?thread=wrong"))).toBe(true);
});

test("a stale workspace read cannot overwrite a later mutation or roll memory revisions backward", () => {
  const ready = readyModel();
  const saving = update(
    modifyFields(ready, { memoryDraft: () => "New memory", memoryRevision: () => 1 }),
    Message.ClickedSaveMemory(),
  ).model;
  const savedWorkspace = {
    sessions: ready.workspace.sessions,
    memory: { text: "New memory", revision: 2 },
  };
  const saved = update(saving, Message.CompletedSaveMemory({ workspace: savedWorkspace })).model;
  const stale = update(
    saved,
    Message.CompletedLoadWorkspace({
      workspace: ready.workspace,
      generation: ready.workspaceGeneration,
    }),
  ).model;
  expect(stale).toEqual(saved);
  expect(stale.workspace.memory.revision).toBe(2);
  const background = update(
    modifyFields(ready, {
      workflow: (workflow) => modifyFields(workflow, { phase: () => "waiting" }),
    }),
    Message.UpdatedWorkflow({ workflow: ready.workflow }),
  ).model;
  expect(background.workspaceActivity).toBe("loading");
  expect(update(background, Message.ClickedNewThread()).model).toEqual(background);
});

test("modal editing blocks the chat submit shortcut and pending memory survives closing and reopening", () => {
  const ready = modifyFields(readyModel(), { draft: () => "Chat draft" });
  const open = update(ready, Message.ClickedSharedMemory()).model;
  expect(canSubmit(open)).toBe(false);
  expect(update(open, Message.SubmittedPrompt()).model).toEqual(open);
  const editing = update(open, Message.UpdatedMemoryDraft({ value: "Keep my pending edit" })).model;
  const saving = update(editing, Message.ClickedSaveMemory()).model;
  const closed = modifyFields(saving, {
    memoryDialog: (dialog) => modifyFields(dialog, { isOpen: () => false }),
  });
  const reopened = update(closed, Message.ClickedSharedMemory()).model;
  const failed = update(
    reopened,
    Message.FailedSaveMemory({ error: "Save failed", conflict: false }),
  ).model;
  expect(failed.memoryDraft).toBe("Keep my pending edit");
  expect(failed.memoryRevision).toBe(1);
});

test("a recreated workflow reselects the preserved thread before writing the root URL", () => {
  const ready = modifyFields(readyModel(), {
    workflow: (workflow) => modifyFields(workflow, { sessionId: () => other }),
  });
  story(
    update,
    given(ready),
    message(Message.UpdatedWorkflow({ workflow: init().model.workflow })),
    Command.expectExact(SelectSession({ sessionId: other })),
    model((value) => expect(value.workflow.sessionId).toBe(other)),
    Command.resolve(SelectSession, Message.FailedWorkflowRequest()),
  );
});

test("opening a thread picker closes options and model settings", () => {
  const openSiblings = modifyFields(readyModel(), {
    workspacePopover: (popover) =>
      modifyFields(popover, { isOpen: () => true, isAnimated: () => false }),
    settingsPopover: (popover) =>
      modifyFields(popover, { isOpen: () => true, isAnimated: () => false }),
  });
  story(
    update,
    given(openSiblings),
    message(Message.GotThreadPopoverMessage({ message: Popover.Message.RequestedOpen() })),
    Command.resolve(
      Popover.FocusButton({ id: "workspace" }),
      Popover.Message.CompletedFocusButton(),
    ),
    Command.resolve(
      Popover.FocusButton({ id: "settings" }),
      Popover.Message.CompletedFocusButton(),
    ),
    Command.resolve(
      LoadWorkspace,
      Message.CompletedLoadWorkspace({
        workspace: openSiblings.workspace,
        generation: openSiblings.workspaceGeneration + 1,
      }),
    ),
    model((value) => {
      expect(value.threadPopover.isOpen).toBe(true);
      expect(value.workspacePopover.isOpen).toBe(false);
      expect(value.settingsPopover.isOpen).toBe(false);
    }),
  );
});

test("workspace actions dismiss the options panel before dispatch", () => {
  const optionsOpen = modifyFields(readyModel(), {
    workspacePopover: (popover) =>
      modifyFields(popover, { isOpen: () => true, isAnimated: () => false }),
  });
  story(
    update,
    given(optionsOpen),
    message(Message.ClickedForkThread()),
    model((value) => expect(value.workspacePopover.isOpen).toBe(false)),
    Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
    Command.resolve(PrepareThread, Message.FailedPrepareThread()),
  );
  story(
    update,
    given(optionsOpen),
    message(Message.ClickedExportConversation()),
    model((value) => expect(value.workspacePopover.isOpen).toBe(false)),
    Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
    Command.resolve(ExportConversation, Message.CompletedExportConversation()),
  );
  story(
    update,
    given(optionsOpen),
    message(Message.ClickedRefresh()),
    model((value) => expect(value.workspacePopover.isOpen).toBe(false)),
    Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
    Command.resolve(RefreshWorkflow, Message.FailedWorkflowRequest()),
  );
});
