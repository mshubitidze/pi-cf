import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { network } from "./setup.ts";
import type { CredentialsProbe } from "./worker.ts";

import { credential } from "./fixtures.ts";

it("preserves rotation across restart with the same seed, and replaces it with a changed seed", async () => {
  let stub = env.CREDENTIALS.getByName("rotation");
  const seed = credential("original");
  const rotated = credential("rotated");
  await runInDurableObject<CredentialsProbe, void>(stub, async ({ credentials }) => {
    await Effect.runPromise(credentials.initialize(Redacted.make(JSON.stringify(seed))));
    await credentials.modify("openai", async () => rotated);
  });
  await abortAllDurableObjects();
  stub = env.CREDENTIALS.get(stub.id);
  await runInDurableObject<CredentialsProbe, void>(stub, async ({ credentials }) => {
    await Effect.runPromise(credentials.initialize(Redacted.make(JSON.stringify(seed))));
    expect(await credentials.read("openai")).toEqual(rotated);
    const replacement = credential("new-login");
    await Effect.runPromise(credentials.initialize(Redacted.make(JSON.stringify(replacement))));
    expect(await credentials.read("openai")).toEqual(replacement);
  });
});

it("serializes concurrent real OAuth refreshes and persists the rotated credential", async () => {
  let stub = env.CREDENTIALS.getByName("refresh");
  let requests = 0;
  network.use(
    http.post("https://auth.openai.com/api/accounts/oauth/token", async ({ request }) => {
      requests++;
      const body = await request.formData();
      expect(body.get("refresh_token")).toBe("refresh-expired");
      expect(body.get("client_id")).toBe("synthetic-test-client");
      return HttpResponse.json({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
      });
    }),
  );
  await runInDurableObject<CredentialsProbe, void>(stub, async ({ credentials }) => {
    await Effect.runPromise(
      credentials.initialize(Redacted.make(JSON.stringify(credential("expired", 0)))),
    );
    registerBunOAuthFlows();
    const models = createModels({ credentials });
    models.setProvider(openaiProvider());
    const auth = await Promise.all([models.getAuth("openai"), models.getAuth("openai")]);
    expect(auth.map((value) => value?.auth.apiKey)).toEqual(["fresh-access", "fresh-access"]);
    expect((await credentials.read("openai"))?.type).toBe("oauth");
  });
  expect(requests).toBe(1);
  await abortAllDurableObjects();
  stub = env.CREDENTIALS.get(stub.id);
  await runInDurableObject<CredentialsProbe, void>(stub, async ({ credentials }) => {
    expect(await credentials.read("openai")).toMatchObject({
      access: "fresh-access",
      refresh: "fresh-refresh",
    });
  });
});
