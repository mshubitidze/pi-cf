import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorize } from "./access.ts";
const config = {
  LOCAL_DEV: "true",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  OWNER_EMAIL: "owner@example.com",
};

test("Access bypass requires local mode and a loopback host; deployment fails closed", async () => {
  expect(
    await Effect.runPromise(authorize(new Request("http://localhost/"), config)),
  ).toBeUndefined();
  expect(
    (await Effect.runPromise(authorize(new Request("https://public.example/"), config)))?.status,
  ).toBe(503);
  expect(
    (
      await Effect.runPromise(
        authorize(new Request("http://localhost/"), { ...config, LOCAL_DEV: "false" }),
      )
    )?.status,
  ).toBe(503);
  expect(
    (
      await Effect.runPromise(
        authorize(new Request("https://public.example/"), {
          ...config,
          ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
          ACCESS_AUD: "aud",
        }),
      )
    )?.status,
  ).toBe(401);
  expect(
    (
      await Effect.runPromise(
        authorize(
          new Request("https://public.example/", {
            headers: { "Cf-Access-Jwt-Assertion": "invalid" },
          }),
          { ...config, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud" },
        ),
      )
    )?.status,
  ).toBe(403);
});

test("Access reuses the configured issuer's JWKS while verifying every assertion", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "test-key" };
  let fetches = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/cdn-cgi/access/certs");
      fetches += 1;
      return Response.json({ keys: [key] });
    },
  });
  const issuer = server.url.origin;
  const access = {
    ...config,
    LOCAL_DEV: "false",
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: "personal-app",
  };
  const token = (
    claims: { email?: string; issuer?: string; audience?: string; expires?: number } = {},
  ) =>
    new SignJWT({ email: claims.email ?? config.OWNER_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(claims.issuer ?? issuer)
      .setAudience(claims.audience ?? access.ACCESS_AUD)
      .setExpirationTime(claims.expires ?? Math.floor(Date.now() / 1000) + 60)
      .sign(privateKey);
  const verify = (assertion: string) =>
    Effect.runPromise(
      authorize(
        new Request("https://private.example/", {
          headers: { "Cf-Access-Jwt-Assertion": assertion },
        }),
        access,
      ),
    );
  try {
    const valid = await token();
    expect(await verify(valid)).toBeUndefined();
    expect(await verify(valid)).toBeUndefined();
    expect(fetches).toBe(1);
    for (const claims of [
      { email: "other@example.com" },
      { issuer: "https://untrusted.example" },
      { audience: "other-app" },
      { expires: 1 },
    ]) {
      expect((await verify(await token(claims)))?.status).toBe(403);
    }
    const otherKey = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: config.OWNER_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(issuer)
      .setAudience(access.ACCESS_AUD)
      .setExpirationTime("1m")
      .sign(otherKey.privateKey);
    expect((await verify(forged))?.status).toBe(403);
    expect(fetches).toBe(1);
  } finally {
    await server.stop(true);
  }
});
