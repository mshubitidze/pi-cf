import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createRemoteJWKSet, jwtVerify } from "jose";

type AccessConfig = {
  LOCAL_DEV: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
};
class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {}) {}
const Claims = Schema.Struct({ email: Schema.NonEmptyString });
// Configured issuers only, never token claims. jose owns expiry, refresh and cooldown.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const keysFor = (issuer: string) => {
  const existing = keySets.get(issuer);
  if (existing) {
    return existing;
  }
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  keySets.set(issuer, keys);
  return keys;
};

/** Every deployed request, including assets, requires a verified Access assertion. */
export const authorize = Effect.fn("Access.authorize")(function* (
  request: Request,
  env: AccessConfig,
) {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return;
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response(
      "Private agent: configure Cloudflare Access before opening this deployment.",
      { status: 503 },
    );
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response("Sign in through Cloudflare Access.", { status: 401 });
  }
  const permitted = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, keysFor(env.ACCESS_TEAM_DOMAIN), {
        issuer: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
      }),
    catch: () => new AccessDenied(),
  }).pipe(
    Effect.flatMap(({ payload }) => Schema.decodeUnknownEffect(Claims)(payload)),
    Effect.map((claims) => claims.email === env.OWNER_EMAIL),
    Effect.orElseSucceed(() => false),
  );
  return permitted ? undefined : new Response("Access denied.", { status: 403 });
});
