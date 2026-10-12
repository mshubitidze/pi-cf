import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { delay, http } from "msw";
import { expect, it } from "vitest";
import { ModelSettings, OperationId, Submission } from "../../src/model.ts";
import { credential, modelDefault, responseStream } from "./fixtures.ts";
import { network } from "./setup.ts";

const assistant = async (name: string) => {
  const stub = env.ASSISTANT.getByName(name);
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.put("oauth:openai", credential("synthetic-access"));
  });
  return stub;
};

it("deduplicates a retried durable submission and retains its outcome after restart", async () => {
  let generations = 0;
  network.use(
    http.post("https://api.openai.com/v1/responses", () => {
      generations++;
      return responseStream("A controlled response.");
    }),
  );
  let stub = await assistant("deduplicate");
  const submission = Submission.make({
    operationId: OperationId.make("same-operation"),
    prompt: "One durable turn.",
  });
  expect(await stub.submit(submission)).toEqual({
    operationId: submission.operationId,
    accepted: true,
  });
  expect(await stub.submit(submission)).toEqual({
    operationId: submission.operationId,
    accepted: false,
  });
  await expect.poll(() => stub.result(submission.operationId)).toEqual({ status: "done" });
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect(await stub.submit(submission)).toEqual({
    operationId: submission.operationId,
    accepted: false,
  });
  expect(await stub.result(submission.operationId)).toEqual({ status: "done" });
  const state = await stub.read();
  expect(state.messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: "user", text: submission.prompt },
    { role: "assistant", text: "A controlled response." },
  ]);
  expect(state.pending).toEqual([]);
  expect(generations).toBe(1);
});

it("recovers an interrupted accepted turn through the durable alarm", async () => {
  let requests = 0;
  network.use(
    http.post("https://api.openai.com/v1/responses", async () => {
      requests++;
      if (requests === 1) {
        await delay(60_000);
      }
      return responseStream("Recovered response.");
    }),
  );
  let stub = await assistant("recovery");
  const submission = Submission.make({
    operationId: OperationId.make("recovery-operation"),
    prompt: "Resume this accepted turn.",
  });
  expect(await stub.submit(submission)).toEqual({
    operationId: submission.operationId,
    accepted: true,
  });
  await expect.poll(() => requests).toBe(1);
  expect(await stub.result(submission.operationId)).toEqual({ status: "pending" });
  expect(
    await stub.configure(ModelSettings.make({ model: "gpt-6-astra", thinkingLevel: "high" })),
  ).toMatchObject({ _tag: "SettingsRejected", reason: "busy" });
  expect((await stub.read()).model).toBe("gpt-6-sol");
  expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).not.toBeNull();
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  // The provider must restart before any observer RPC can wake Pi.
  await expect.poll(() => requests).toBe(2);
  await expect.poll(() => stub.result(submission.operationId)).toEqual({ status: "done" });
  const state = await stub.read();
  expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(state.messages.at(-1)?.text).toBe("Recovered response.");
  expect(state.pending).toEqual([]);
  expect(requests).toBeGreaterThanOrEqual(2);
});

it("persists model and reasoning together without losing history and uses them on the next turn", async () => {
  const requests: Array<unknown> = [];
  network.use(
    http.post("https://api.openai.com/v1/responses", async ({ request }) => {
      requests.push(await request.json());
      return responseStream("Saved conversation response.");
    }),
  );
  let stub = await assistant("settings-persistence");
  const first = Submission.make({
    operationId: OperationId.make("settings-before-change"),
    prompt: "Keep this history.",
  });
  await stub.submit(first);
  await expect.poll(() => stub.result(first.operationId)).toEqual({ status: "done" });
  const before = await stub.read();
  expect(before.models.find((model) => model.id === "gpt-6-astra")?.thinkingLevels).toContain(
    "high",
  );
  expect(before.models.find((model) => model.id === "gpt-4.1")?.thinkingLevels).toEqual(["off"]);
  expect(
    await stub.configure(ModelSettings.make({ model: "not-a-model", thinkingLevel: "high" })),
  ).toMatchObject({ reason: "unsupported" });
  expect(
    await stub.configure(ModelSettings.make({ model: "gpt-4.1", thinkingLevel: "high" })),
  ).toMatchObject({ reason: "unsupported" });
  expect((await stub.read()).model).toBe(before.model);
  const settings = ModelSettings.make({ model: "gpt-6-astra", thinkingLevel: "high" });
  expect(await stub.configure(settings)).toMatchObject(settings);
  await abortAllDurableObjects();
  stub = env.ASSISTANT.get(stub.id);
  const restored = await stub.read();
  expect(restored).toMatchObject(settings);
  expect(restored.messages).toEqual(before.messages);
  const second = Submission.make({
    operationId: OperationId.make("settings-after-change"),
    prompt: "Use the new settings.",
  });
  await stub.submit(second);
  await expect.poll(() => stub.result(second.operationId)).toEqual({ status: "done" });
  expect(requests.at(-1)).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "high" } });
});

it("rejects direct durable submission without a configured credential", async () => {
  const stub = env.ASSISTANT.getByName("missing-login");
  const submission = Submission.make({
    operationId: OperationId.make("missing-credential"),
    prompt: "Do not admit this.",
  });
  expect(await stub.submit(submission)).toMatchObject({ _tag: "ConnectionMissing" });
  const state = await stub.read();
  expect(state.pending).toEqual([]);
  expect(state.messages).toEqual([]);
});

it("reports the persisted model after the creation default changes", async () => {
  modelDefault.id = "gpt-6-sol";
  let stub = env.MODEL_ASSISTANT.getByName("model-default");
  expect((await stub.read()).model).toBe("gpt-6-sol");
  await abortAllDurableObjects();
  modelDefault.id = "gpt-6-astra";
  stub = env.MODEL_ASSISTANT.get(stub.id);
  expect((await stub.read()).model).toBe("gpt-6-sol");
  expect((await env.MODEL_ASSISTANT.getByName("new-model-default").read()).model).toBe(
    "gpt-6-astra",
  );
});
