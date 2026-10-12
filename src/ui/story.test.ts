import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { init, Message, RefreshWorkflow, SubmitPrompt, update } from "./main.ts";
import { ChatState, OperationId, ROOT_SESSION } from "../model.ts";
import { WorkflowView } from "./workflow.ts";

test("submission disables duplicate clicks and preserves the draft when preparation fails", () => {
  const ready = WorkflowView.make({
    sessionId: ROOT_SESSION,
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
  });
  story(
    update,
    given(init().model),
    message(Message.UpdatedWorkflow({ workflow: ready })),
    message(Message.UpdatedDraft({ value: "Hello" })),
    message(Message.SubmittedPrompt()),
    model((value) => expect(value.dispatch._tag).toBe("Preparing")),
    model((value) => expect(update(value, Message.SubmittedPrompt()).model).toEqual(value)),
    Command.expectExact(SubmitPrompt({ prompt: "Hello", sessionId: ROOT_SESSION })),
    Command.resolve(SubmitPrompt, Message.FailedSubmitPrompt()),
    model((value) => {
      expect(value.draft).toBe("Hello");
      expect(value.dispatch._tag).toBe("Idle");
    }),
  );
});

const readyModel = () =>
  update(
    init().model,
    Message.UpdatedWorkflow({
      workflow: WorkflowView.make({
        sessionId: ROOT_SESSION,
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
      }),
    }),
  ).model;

test("submit and refresh synchronously exclude each other in either order", () => {
  const draft = update(readyModel(), Message.UpdatedDraft({ value: "Keep this draft" })).model;
  const submitting = update(draft, Message.SubmittedPrompt()).model;
  expect(update(submitting, Message.ClickedRefresh()).model).toEqual(submitting);
  const refreshing = update(draft, Message.ClickedRefresh()).model;
  expect(update(refreshing, Message.SubmittedPrompt()).model).toEqual(refreshing);
  expect(refreshing.draft).toBe("Keep this draft");
});

test("acknowledgement and snapshot can arrive in either order without reopening a stale ready state", () => {
  const requestId = OperationId.make("acknowledged-request-123");
  const draft = update(readyModel(), Message.UpdatedDraft({ value: "Hello" })).model;
  const preparing = update(draft, Message.SubmittedPrompt()).model;
  const projected = Message.UpdatedWorkflow({
    workflow: WorkflowView.make({
      ...preparing.workflow,
      phase: "submitting",
      maybeAcknowledgedRequestId: Option.some(requestId),
    }),
  });
  const completed = Message.CompletedSubmitPrompt({ requestId, sessionId: ROOT_SESSION });
  const completedFirst = update(preparing, completed).model;
  expect(completedFirst.dispatch._tag).toBe("AwaitingSnapshot");
  expect(update(completedFirst, Message.ClickedRefresh()).model).toEqual(completedFirst);
  const first = update(completedFirst, projected).model;
  const second = update(update(preparing, projected).model, completed).model;
  expect(first).toEqual(second);
  expect(first.dispatch._tag).toBe("Idle");
  expect(first.draft).toBe("");
});

test("refresh failure unlocks the draft and a later refresh waits for its matching snapshot", () => {
  const requestId = OperationId.make("refresh-request-123");
  const ready = readyModel();
  story(
    update,
    given(ready),
    message(Message.UpdatedDraft({ value: "Keep this draft" })),
    message(Message.ClickedRefresh()),
    Command.resolve(RefreshWorkflow, Message.FailedWorkflowRequest()),
    model((value) => {
      expect(value.dispatch._tag).toBe("Idle");
      expect(value.draft).toBe("Keep this draft");
      expect(Option.getOrNull(value.maybeFeedback)).toBe("Could not reconnect. Please try again.");
    }),
    message(Message.ClickedRefresh()),
    Command.resolve(RefreshWorkflow, Message.CompletedRefreshWorkflow({ requestId })),
    model((value) => expect(value.dispatch._tag).toBe("AwaitingSnapshot")),
    message(
      Message.UpdatedWorkflow({
        workflow: modifyFields(ready.workflow, {
          phase: () => "loading",
          maybeAcknowledgedRequestId: () => Option.some(requestId),
        }),
      }),
    ),
    model((value) => {
      expect(value.dispatch._tag).toBe("Idle");
      expect(value.draft).toBe("Keep this draft");
      expect(Option.isNone(value.maybeFeedback)).toBe(true);
    }),
  );
});
