import { Dialog, Popover } from "@foldkit/ui";
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
  text,
  type,
  Subscription,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { ROOT_SESSION, SessionId } from "../model.ts";
import type { Model } from "./model.ts";
import { init, Message, update, view, StopWorkflow } from "./main.ts";
import { SaveMemory, SelectSession, LoadWorkspace } from "./workspace.ts";

const other = SessionId.make("2");
const readyModel = (): Model =>
  modifyFields(init().model, {
    workspaceActivity: () => "idle",
    workspace: () => ({
      sessions: [
        { id: ROOT_SESSION, title: "Current thread", archived: false, busy: false },
        { id: other, title: "Old ideas", archived: true, busy: false },
      ],
      memory: { text: "Saved preferences", revision: 1 },
    }),
    workflow: (workflow) =>
      modifyFields(workflow, {
        phase: () => "ready",
        chat: (chat) => modifyFields(chat, { connection: () => "connected" }),
      }),
  });

test("thread search separates archived conversations and selecting keeps the old draft", () => {
  const ready = readyModel();
  scene(
    { update, view },
    given(ready),
    type(label("Message Pi"), "Keep this draft"),
    click(role("button", { name: "Switch thread" })),
    Mount.resolve(Popover.PortalPopoverBackdrop, Popover.Message.CompletedPortalPopoverBackdrop()),
    Mount.resolve(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover()),
    Command.resolve(
      LoadWorkspace,
      Message.CompletedLoadWorkspace({
        workspace: ready.workspace,
        generation: ready.workspaceGeneration + 1,
      }),
    ),
    expect(role("button", { name: "Current thread" })).toBeVisible(),
    expect(role("button", { name: "Old ideas" })).not.toExist(),
    click(role("button", { name: "Archived" })),
    expect(role("button", { name: "Old ideas" })).toBeVisible(),
    type(label("Search threads"), "no match"),
    expect(text("No matching threads.")).toBeVisible(),
    type(label("Search threads"), "ideas"),
    click(role("button", { name: "Old ideas" })),
    Command.resolve(SelectSession, Message.FailedWorkflowRequest()),
    Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
    Mount.expectEnded(Popover.PortalPopoverBackdrop, Popover.AnchorPopover),
    expect(label("Message Pi")).toHaveValue("Keep this draft"),
  );
});

test("memory failure keeps edits visible and an explicit save retry retains the revision", () => {
  const ready = modifyFields(readyModel(), {
    memoryDialog: (dialog) => modifyFields(dialog, { isOpen: () => true }),
    memoryDraft: () => "Saved preferences",
    memoryRevision: () => 1,
  });
  scene(
    { update, view },
    given(ready),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("dialog", { name: "Shared memory" })).toBeVisible(),
    type(label("Memory"), "My unsaved preferences"),
    click(role("button", { name: "Save memory" })),
    Command.resolve(
      SaveMemory,
      Message.FailedSaveMemory({ error: "Could not save memory", conflict: false }),
    ),
    expect(role("alert")).toBeVisible(),
    expect(label("Memory")).toHaveValue("My unsaved preferences"),
    click(role("button", { name: "Save memory" })),
    Command.resolve(
      SaveMemory,
      Message.FailedSaveMemory({ error: "Still unavailable", conflict: false }),
    ),
    expect(label("Memory")).toHaveValue("My unsaved preferences"),
  );
});

test("active response shows Stop while navigation stays available", () => {
  const waiting: Model = modifyFields(readyModel(), {
    workflow: (workflow) => modifyFields(workflow, { phase: () => "waiting" }),
  });
  scene(
    { update, view },
    given(waiting),
    expect(role("button", { name: "Stop response" })).toBeEnabled(),
    expect(role("button", { name: "Switch thread" })).toBeEnabled(),
    click(role("button", { name: "Stop response" })),
    Command.resolve(StopWorkflow, Message.FailedWorkflowRequest()),
    Subscription.emit(
      Message.UpdatedWorkflow({
        workflow: modifyFields(waiting.workflow, { phase: () => "stopping" }),
      }),
    ),
    expect(text("Stopping…")).toBeVisible(),
    expect(role("button", { name: "Stop response" })).toBeDisabled(),
  );
});

test("a failed new thread remains visible outside the closed switcher", () => {
  const failed = update(
    readyModel(),
    Message.FailedCreateThread({ error: "Could not confirm the new thread", rejected: false }),
  ).model;
  scene(
    { update, view },
    given(failed),
    expect(role("alert")).toBeVisible(),
    expect(text("Could not confirm the new thread")).toBeVisible(),
    expect(role("button", { name: "Retry creating thread" })).toBeVisible(),
    expect(role("button", { name: "New thread" })).toBeDisabled(),
  );
});
