import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { delay, http } from "msw";
import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  CreateSession,
  ModelSettings,
  OperationId,
  ROOT_SESSION,
  SessionId,
  SharedMemory,
  Submission,
  UpdateSession,
} from "../../src/model.ts";
import { credential, responseStream } from "./fixtures.ts";
import { network } from "./setup.ts";

const assistant = async (name: string) => {
  const stub = env.ASSISTANT.getByName(name);
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.put("oauth:openai", credential("synthetic-workspace-access"));
  });
  return stub;
};

const submission = (operationId: string, prompt: string) =>
  Submission.make({ operationId: OperationId.make(operationId), prompt });

const create = async (
  stub: DurableObjectStub<import("../../src/platform/cloudflare/assistant.ts").Assistant>,
  operationId: string,
  title = "",
  forkFrom?: SessionId,
) => {
  const result = await stub.createSession(
    CreateSession.make({
      operationId: OperationId.make(operationId),
      title,
      ...(forkFrom ? { forkFrom } : {}),
    }),
  );
  if (!("sessionId" in result)) throw new Error(`Creation rejected: ${result.reason}`);
  return { ...result, sessionId: SessionId.make(result.sessionId) };
};

it("isolates transcript, pending work, settings, and operation lookup by native session", async () => {
  let requests = 0;
  network.use(
    http.post("https://api.openai.com/v1/responses", async () => {
      requests++;
      if (requests === 1) await delay(60_000);
      return responseStream("Separate session response.");
    }),
  );
  const stub = await assistant("workspace-isolation");
  const child = await create(stub, "new-child-operation");
  const rootTurn = submission("root-pending-operation", "Root is still running.");
  expect(await stub.submit(rootTurn)).toEqual({
    operationId: rootTurn.operationId,
    accepted: true,
  });
  await expect.poll(() => requests, { timeout: 5000 }).toBe(1);
  expect((await stub.read()).pending).toEqual([rootTurn.operationId]);
  expect((await stub.read(child.sessionId)).pending).toEqual([]);
  const settings = ModelSettings.make({ model: "gpt-6-astra", thinkingLevel: "high" });
  expect(await stub.configure(settings, child.sessionId)).toMatchObject(settings);
  expect((await stub.read()).model).toBe("gpt-6-sol");
  await expect(stub.result(rootTurn.operationId, child.sessionId)).rejects.toBeDefined();
  const childTurn = submission("child-turn-operation", "Only in the child.");
  await stub.submit(childTurn, child.sessionId);
  await expect
    .poll(() => stub.result(childTurn.operationId, child.sessionId))
    .toEqual({ status: "done" });
  expect((await stub.read(child.sessionId)).messages.map((entry) => entry.text)).toEqual([
    "Only in the child.",
    "Separate session response.",
  ]);
  expect((await stub.workspace()).sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: ROOT_SESSION, busy: true }),
      expect.objectContaining({ id: child.sessionId, busy: false, title: "Only in the child." }),
    ]),
  );
  await stub.stop(ROOT_SESSION);
});

it("atomically deduplicates creation and forks across retry and restart without replacing root", async () => {
  network.use(
    http.post("https://api.openai.com/v1/responses", () => responseStream("Root response.")),
  );
  let stub = await assistant("workspace-create-fork");
  const turn = submission("fork-source-operation", "Keep root history.");
  await stub.submit(turn);
  await expect.poll(() => stub.result(turn.operationId)).toEqual({ status: "done" });
  const continuation = submission("fork-source-continuation", "Keep the latest turn too.");
  await stub.submit(continuation);
  await expect.poll(() => stub.result(continuation.operationId)).toEqual({ status: "done" });
  const root = await stub.read();
  expect(root.messages).toHaveLength(4);
  const input = CreateSession.make({
    operationId: OperationId.make("concurrent-create-operation"),
    title: "Research",
  });
  const results = await Promise.all([stub.createSession(input), stub.createSession(input)]);
  expect(results[0]).toEqual(results[1]);
  const fork = await create(stub, "fork-once-operation", "Branch", ROOT_SESSION);
  expect((await stub.read(fork.sessionId)).messages).toEqual(root.messages);
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect((await create(stub, "fork-once-operation", "Branch", ROOT_SESSION)).sessionId).toBe(
    fork.sessionId,
  );
  expect(
    await stub.createSession(
      CreateSession.make({
        operationId: OperationId.make("fork-once-operation"),
        title: "Wrong request",
        forkFrom: ROOT_SESSION,
      }),
    ),
  ).toMatchObject({ _tag: "WorkspaceRejected", reason: "conflict" });
  expect((await stub.workspace()).sessions).toHaveLength(3);
  expect(await stub.read()).toEqual(root);
  const branchTurn = submission("branch-next-operation", "Branch-only continuation.");
  await stub.submit(branchTurn, fork.sessionId);
  await expect
    .poll(() => stub.result(branchTurn.operationId, fork.sessionId))
    .toEqual({ status: "done" });
  expect((await stub.read()).messages).toEqual(root.messages);
});

it("forks an empty session with its persisted settings and honors explicit titles", async () => {
  network.use(
    http.post("https://api.openai.com/v1/responses", () => responseStream("Named response.")),
  );
  const stub = await assistant("workspace-empty-fork");
  const settings = ModelSettings.make({ model: "gpt-6-astra", thinkingLevel: "high" });
  await stub.configure(settings);
  const fork = await create(stub, "fork-empty-operation", "Custom title", ROOT_SESSION);
  expect(await stub.read(fork.sessionId)).toMatchObject({ ...settings, messages: [] });
  const turn = submission("fork-empty-turn-operation", "A prompt must not overwrite the title.");
  await stub.submit(turn, fork.sessionId);
  await expect
    .poll(() => stub.result(turn.operationId, fork.sessionId))
    .toEqual({ status: "done" });
  expect(
    (await stub.workspace()).sessions.find((entry) => entry.id === fork.sessionId)?.title,
  ).toBe("Custom title");
});

it("archives without deleting history, rejects new turns, and keeps accepted retry receipts", async () => {
  network.use(
    http.post("https://api.openai.com/v1/responses", () => responseStream("Retained response.")),
  );
  let stub = await assistant("workspace-archive");
  const child = await create(stub, "archive-create-operation");
  const turn = submission("archive-turn-operation", "Retain this child.");
  await stub.submit(turn, child.sessionId);
  await expect
    .poll(() => stub.result(turn.operationId, child.sessionId))
    .toEqual({ status: "done" });
  const history = (await stub.read(child.sessionId)).messages;
  expect(
    await stub.updateSession(
      child.sessionId,
      UpdateSession.make({ title: "Saved thread", archived: true }),
    ),
  ).toMatchObject({
    sessions: expect.arrayContaining([
      expect.objectContaining({ id: child.sessionId, title: "Saved thread", archived: true }),
    ]),
  });
  expect(await stub.submit(turn, child.sessionId)).toEqual({
    operationId: turn.operationId,
    accepted: false,
  });
  expect(
    await stub.submit(submission("archive-blocked-operation", "Must not run."), child.sessionId),
  ).toMatchObject({ reason: "archived" });
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect((await stub.read(child.sessionId)).messages).toEqual(history);
  expect(
    (await stub.workspace()).sessions.find((entry) => entry.id === child.sessionId),
  ).toMatchObject({ title: "Saved thread", archived: true });
  expect((await stub.read()).messages).toEqual([]);
  await stub.updateSession(
    child.sessionId,
    UpdateSession.make({ title: "Restored thread", archived: false }),
  );
  expect(
    (await stub.workspace()).sessions.find((entry) => entry.id === child.sessionId)?.archived,
  ).toBe(false);
});

it("compares memory revisions atomically, persists them, and renders shared memory for every session", async () => {
  const requests: string[] = [];
  network.use(
    http.post("https://api.openai.com/v1/responses", async ({ request }) => {
      requests.push(await request.text());
      return responseStream("Memory-aware response.");
    }),
  );
  let stub = await assistant("workspace-memory");
  expect((await stub.workspace()).memory).toEqual({ text: "", revision: 0 });
  const saves = await Promise.all([
    stub.saveMemory(SharedMemory.make({ text: "My preferred language is Georgian.", revision: 0 })),
    stub.saveMemory(SharedMemory.make({ text: "A stale edit.", revision: 0 })),
  ]);
  expect(saves.filter((result) => "memory" in result)).toHaveLength(1);
  expect(saves.filter((result) => "_tag" in result)).toEqual([
    { _tag: "WorkspaceRejected", reason: "conflict" },
  ]);
  const memory = (await stub.workspace()).memory;
  const child = await create(stub, "memory-child-operation");
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect((await stub.workspace()).memory).toEqual(memory);
  for (const id of [ROOT_SESSION, child.sessionId]) {
    const turn = submission(`memory-turn-${id}`, "Use my preferences.");
    await stub.submit(turn, id);
    await expect.poll(() => stub.result(turn.operationId, id)).toEqual({ status: "done" });
    expect(requests.at(-1)).toContain(memory.text);
  }
  expect(
    await stub.saveMemory(SharedMemory.make({ text: "", revision: memory.revision })),
  ).toMatchObject({ memory: { text: "", revision: 2 } });
  const cleared = submission("memory-cleared-turn", "Memory was cleared.");
  await stub.submit(cleared, child.sessionId);
  await expect
    .poll(() => stub.result(cleared.operationId, child.sessionId))
    .toEqual({ status: "done" });
  const request = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        input: Schema.Array(
          Schema.Struct({
            role: Schema.optional(Schema.String),
            content: Schema.optional(Schema.Unknown),
          }),
        ),
      }),
    ),
  )(requests.at(-1) ?? "");
  // Pi preserves historical context and sends a new explicit removal to the model.
  expect(request.input.filter((entry) => entry.role === "developer").at(-1)?.content).toBe(
    'Removed system prompt section "shared_memory".',
  );
});

it("stops running and queued work durably and permits a fresh turn after restart", async () => {
  let requests = 0;
  network.use(
    http.post("https://api.openai.com/v1/responses", async () => {
      requests++;
      if (requests === 1) await delay(60_000);
      return responseStream("Fresh response after stopping.");
    }),
  );
  let stub = await assistant("workspace-stop");
  const running = submission("stop-running-operation", "Run until stopped.");
  const queued = submission("stop-queued-operation", "Queued work must also stop.");
  await stub.submit(running);
  await expect.poll(() => requests).toBe(1);
  await stub.submit(queued);
  expect(
    await stub.updateSession(
      ROOT_SESSION,
      UpdateSession.make({ title: "Running", archived: true }),
    ),
  ).toMatchObject({ reason: "busy" });
  expect(
    await stub.createSession(
      CreateSession.make({
        operationId: OperationId.make("busy-fork-operation"),
        title: "",
        forkFrom: ROOT_SESSION,
      }),
    ),
  ).toMatchObject({ reason: "busy" });
  expect(await stub.stop(ROOT_SESSION)).toMatchObject({ pending: [] });
  expect(await stub.result(running.operationId)).toEqual({ status: "unanswered" });
  expect(await stub.result(queued.operationId)).toEqual({ status: "unanswered" });
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect((await stub.read()).pending).toEqual([]);
  expect(await stub.submit(running)).toEqual({ operationId: running.operationId, accepted: false });
  const fresh = submission("stop-fresh-operation", "Start fresh work.");
  await stub.submit(fresh);
  await expect.poll(() => stub.result(fresh.operationId)).toEqual({ status: "done" });
  expect(requests).toBe(2);
  expect((await stub.read()).messages.at(-1)?.text).toBe("Fresh response after stopping.");
});

it("rejects unknown mutations and paginates native sessions without deleting root", async () => {
  const stub = await assistant("workspace-pagination");
  const unknown = SessionId.make("999");
  expect(await stub.stop(unknown)).toMatchObject({ reason: "not-found" });
  expect(
    await stub.updateSession(unknown, UpdateSession.make({ title: "Missing", archived: false })),
  ).toMatchObject({ reason: "not-found" });
  expect(
    await stub.submit(submission("missing-session-operation", "Missing session."), unknown),
  ).toMatchObject({ reason: "not-found" });
  expect(
    await stub.configure(ModelSettings.make({ model: "gpt-6-sol", thinkingLevel: "low" }), unknown),
  ).toMatchObject({ reason: "not-found" });
  expect(
    await stub.createSession(
      CreateSession.make({
        operationId: OperationId.make("missing-fork-operation"),
        title: "",
        forkFrom: unknown,
      }),
    ),
  ).toMatchObject({ reason: "not-found" });
  // Valid operation IDs may also be inherited object-property names.
  const named = await create(stub, "constructor", "A safe receipt key");
  expect((await create(stub, "constructor", "A safe receipt key")).sessionId).toBe(named.sessionId);
  for (let index = 0; index < 99; index++) {
    await create(stub, `paginated-create-${index}`);
  }
  const workspace = await stub.workspace();
  expect(workspace.sessions).toHaveLength(101);
  await stub.updateSession(
    named.sessionId,
    UpdateSession.make({ title: "Beyond the first page", archived: false }),
  );
  expect(
    (await stub.workspace()).sessions.find((entry) => entry.id === named.sessionId)?.title,
  ).toBe("Beyond the first page");
  expect(workspace.sessions.find((entry) => entry.id === ROOT_SESSION)).toMatchObject({
    title: "Main conversation",
    archived: false,
  });
  expect((await stub.read()).messages).toEqual([]);
});
