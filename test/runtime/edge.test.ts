import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { network } from "./setup.ts";
import worker from "../../src/platform/cloudflare/edge.ts";
import { runInDurableObject } from "cloudflare:test";
import { credential } from "./fixtures.ts";

it("fails closed on deployed hosts for both assets and API routes", async () => {
  for (const path of ["/", "/api/health"]) {
    const response = await exports.default.fetch(`https://private.example.invalid${path}`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("configure Cloudflare Access");
  }
  const response = await worker.fetch(new Request("https://private.example.invalid/"), {
    ...env,
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
  });
  expect(response.status).toBe(401);
});

it("validates settings over HTTP and returns the durable selection through RPC", async () => {
  const stub = env.ASSISTANT.getByName("personal");
  await runInDurableObject(stub, (_, state) =>
    state.storage.put("oauth:openai", credential("settings-http")),
  );
  const post = (body: unknown, origin = "http://localhost") =>
    exports.default.fetch("http://localhost/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  expect(
    (await post({ model: "gpt-6-astra", thinkingLevel: "high" }, "https://foreign.invalid")).status,
  ).toBe(403);
  expect((await post({ model: "gpt-6-astra", thinkingLevel: "invented" })).status).toBe(400);
  expect((await post({ model: "unknown", thinkingLevel: "high" })).status).toBe(400);
  const response = await post({ model: "gpt-6-astra", thinkingLevel: "high" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ model: "gpt-6-astra", thinkingLevel: "high" });
  expect(await (await exports.default.fetch("http://localhost/api/chat")).json()).toMatchObject({
    model: "gpt-6-astra",
    thinkingLevel: "high",
  });
});

it("permits the explicit loopback bypass and protects write origins and body boundaries", async () => {
  expect((await exports.default.fetch("http://localhost/api/health")).status).toBe(200);
  expect(await (await exports.default.fetch("http://localhost/")).text()).toBe("test asset");
  const post = (headers: Record<string, string>, body = "{}") =>
    exports.default.fetch("http://localhost/api/chat", {
      method: "POST",
      headers,
      body,
    });
  expect(
    (await post({ "content-type": "application/json", origin: "https://foreign.invalid" })).status,
  ).toBe(403);
  expect((await post({ "content-type": "text/plain", origin: "http://localhost" })).status).toBe(
    415,
  );
  expect(
    (await post({ "content-type": "application/json", origin: "http://localhost" }, "invalid json"))
      .status,
  ).toBe(400);
  expect(
    (
      await post(
        { "content-type": "application/json", origin: "http://localhost" },
        " ".repeat(40_000) + JSON.stringify({ operationId: "valid-operation", prompt: "Hello" }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await post(
        { "content-type": "application/json", origin: "http://localhost" },
        JSON.stringify({ operationId: "valid-operation", prompt: "Hello" }),
      )
    ).status,
  ).toBe(409);
});

it("bounds streamed request bodies without trusting Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(16_384)));
      controller.enqueue(new TextEncoder().encode(" ".repeat(16_384)));
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ operationId: "streamed-operation", prompt: "Hello" }),
        ),
      );
      controller.close();
    },
  });
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body,
  });
  expect(request.headers.has("content-length")).toBe(false);
  const response = await worker.fetch(request, env);
  expect(response.status).toBe(400);
});

it("verifies Access signatures and reuses the issuer's JWKS across requests", async () => {
  const issuer = "https://runtime-test.cloudflareaccess.com";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  let jwksRequests = 0;
  network.use(
    http.get(`${issuer}/cdn-cgi/access/certs`, () => {
      jwksRequests++;
      return HttpResponse.json({ keys: [key] });
    }),
  );
  const token = (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("runtime-test-audience")
      .setExpirationTime("2m")
      .sign(privateKey);
  const request = async (assertion: string) =>
    worker.fetch(
      new Request("https://private.example.invalid/api/health", {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      }),
      {
        ...env,
        LOCAL_DEV: "false",
        ACCESS_TEAM_DOMAIN: issuer,
        ACCESS_AUD: "runtime-test-audience",
      },
    );
  const ownerToken = await token(env.OWNER_EMAIL);
  expect((await request(ownerToken)).status).toBe(200);
  expect((await request(ownerToken)).status).toBe(200);
  expect((await request(await token("somebody-else@example.invalid"))).status).toBe(403);
  expect((await request("invalid.assertion.token")).status).toBe(403);
  expect(jwksRequests).toBe(1);
});
