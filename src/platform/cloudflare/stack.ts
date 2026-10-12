import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import type { Assistant } from "./assistant.ts";

const ownerEmail = "misho@mshub.dev";
const hostname = "pi.mshub.dev";

export const App = Cloudflare.Website.Foldkit(
  "App",
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
    const access = dev
      ? undefined
      : yield* Cloudflare.Access.Application("Access", {
          type: "self_hosted",
          name: "Personal Pi",
          domain: hostname,
          // Keep the hostname alongside the Worker destinations added by Alchemy.
          destinations: [{ type: "public", uri: hostname }],
          policies: [{ decision: "allow", include: [{ email: ownerEmail }] }],
        });
    return {
      main: "src/platform/cloudflare/edge.ts",
      domain: dev ? undefined : hostname,
      workersDev: dev ? undefined : false,
      access,
      env: {
        ASSISTANT: Cloudflare.DurableObject<Assistant>("Assistant"),
        CHATGPT_CREDENTIAL: dev
          ? Config.Redacted("CHATGPT_CREDENTIAL").pipe(Config.withDefault(Redacted.make("")))
          : Config.Redacted("CHATGPT_CREDENTIAL"),
        MODEL_ID: Config.String("MODEL_ID").pipe(Config.withDefault("gpt-6-sol")),
        LOCAL_DEV: dev ? "true" : "false",
        ACCESS_TEAM_DOMAIN: dev ? "" : Config.String("ACCESS_TEAM_DOMAIN"),
        ACCESS_AUD: access?.aud ?? "",
        OWNER_EMAIL: ownerEmail,
      },
      assets: { runWorkerFirst: true },
      compatibility: { date: "2026-10-08" },
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
      },
    };
  }),
);

export type AppEnv = Cloudflare.InferEnv<typeof App>;

const state = Layer.unwrap(
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
    return dev ? Alchemy.localState() : Cloudflare.state();
  }),
);

export default Alchemy.Stack(
  "pi-personal",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const app = yield* App;
    return { url: app.url };
  }),
);
