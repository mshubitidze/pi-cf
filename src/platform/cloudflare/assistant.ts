import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { Type } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  ChatState,
  ChatUnavailable,
  ConnectionMissing,
  OperationId,
  Outcome,
  Receipt,
  Submission,
  SubmissionResult,
  ModelSettings,
  SettingsRejected,
  SettingsResult,
} from "../../model.ts";
import { DurableCredentials } from "./credentials.ts";

type Env = { CHATGPT_CREDENTIAL: string; MODEL_ID: string };
const invoke = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: () => new ChatUnavailable({ operation }) });

/** Cloudflare's native lifecycle owns Pi recovery and alarms; one personal object owns OAuth. */
export class Assistant extends DurableObject<Env> {
  private readonly credentials = new DurableCredentials(this.ctx.storage);
  private readonly models = createModels({ credentials: this.credentials });
  private readonly admission = Semaphore.makeUnsafe(1);
  private readonly registry = createRegistry();
  private readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      await Effect.runPromise(
        this.credentials.initialize(Redacted.make(this.env.CHATGPT_CREDENTIAL)),
      );
      this.registry.install({
        name: "personal-assistant",
        sections: [
          {
            key: "assistant_guidance",
            render: () =>
              "You are a helpful personal assistant. Be concise. Use word_count when asked to count words. You currently have no browser or shell tools.",
            tag: false,
          },
        ],
        tools: [
          {
            name: "word_count",
            description: "Count words in supplied text.",
            parameters: Type.Object({ text: Type.String() }),
            replay: "safe",
            execute: async ({ text }) => ({
              content: [
                { type: "text", text: String(text.trim() ? text.trim().split(/\s+/u).length : 0) },
              ],
            }),
          },
        ],
      });
      // Pi’s public static loader keeps OAuth imports reachable in Worker bundles.
      // Only token derivation/refresh run here; interactive login stays in the CLI.
      registerBunOAuthFlows();
      this.models.setProvider(openaiProvider());
      return Harness.open(storage, { models: this.models, registry: this.registry }, context);
    },
    defaults: { model: { provider: "openai", id: this.env.MODEL_ID }, thinkingLevel: "low" },
  });
  /** Install the official PiHarness lifecycle on a native Durable Object. */
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  /** Persist a submission before acknowledging it; Pi deduplicates operation IDs. */
  submit(input: Submission) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeEffect(Submission)(input);
        // Opening Pi imports the configured seed before admission checks storage.
        yield* invoke("initialize", () => this.harness.pi());
        const connected = yield* invoke("connection", () => this.credentials.read("openai"));
        if (!connected) {
          return yield* Schema.encodeEffect(SubmissionResult)(new ConnectionMissing());
        }
        const receipt = yield* invoke("submit", () =>
          this.harness.submit(parsed.prompt, { operationId: parsed.operationId }),
        );
        return yield* Schema.decodeEffect(Receipt)(receipt).pipe(
          Effect.flatMap(Schema.encodeEffect(SubmissionResult)),
        );
      }).pipe(this.admission.withPermit),
    );
  }

  /** Commit both settings through Pi; admission excludes concurrent new submissions. */
  configure(input: ModelSettings) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const settings = yield* Schema.decodeEffect(ModelSettings)(input);
        yield* invoke("initialize", () => this.harness.pi());
        const available = yield* invoke("models", () => this.models.getAvailable("openai"));
        const model = available.find((choice) => choice.id === settings.model);
        if (!model || !getSupportedThinkingLevels(model).includes(settings.thinkingLevel)) {
          return yield* Schema.encodeEffect(SettingsResult)(
            new SettingsRejected({ reason: "unsupported" }),
          );
        }
        const pending = yield* invoke("pending", () => this.harness.pending());
        const busy = yield* invoke("busy", () => this.harness.session().busy());
        if (pending.length > 0 || busy) {
          return yield* Schema.encodeEffect(SettingsResult)(
            new SettingsRejected({ reason: "busy" }),
          );
        }
        yield* invoke("configure", async () => {
          const pi = await this.harness.pi();
          const conversation = await pi.root(BACKGROUND_CONTEXT);
          await conversation.configure(
            {
              model: { provider: "openai", modelId: settings.model },
              thinkingLevel: settings.thinkingLevel,
            },
            BACKGROUND_CONTEXT,
          );
        });
        const state = yield* invoke("read", () => this.read());
        return yield* Schema.encodeEffect(SettingsResult)(state);
      }).pipe(this.admission.withPermit),
    );
  }

  /** Expose text and pending operations without credentials or private reasoning. */
  read() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const snapshot = yield* invoke("history", async () => {
          const events = await this.harness.session().events();
          try {
            return events.snapshot;
          } finally {
            await events.stop();
          }
        });
        const pending = yield* invoke("pending", () => this.harness.pending());
        const connected = yield* invoke("connection", () => this.credentials.read("openai"));
        const models = yield* invoke("models", () => this.models.getAvailable("openai"));
        const messages = snapshot.entries.flatMap((entry) =>
          (entry.model ?? []).flatMap((message, index) => {
            if (message.role !== "user" && message.role !== "assistant") {
              return [];
            }
            const text =
              typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n");
            return text ? [{ id: `${entry.id}:${index}`, role: message.role, text }] : [];
          }),
        );
        return yield* Schema.decodeEffect(ChatState)({
          messages,
          pending: pending.map((entry) => entry.operationId),
          connection: connected ? "connected" : "missing",
          model: snapshot.agent.model?.modelId ?? "",
          thinkingLevel: snapshot.agent.thinkingLevel ?? "off",
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            thinkingLevels: getSupportedThinkingLevels(model),
          })),
        });
      }),
    );
  }

  /** A bounded wait never cancels the accepted operation. */
  result(id: OperationId) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const operationId = yield* Schema.decodeEffect(OperationId)(id);
        const signal = AbortSignal.timeout(1000);
        return yield* invoke("result", () => this.harness.wait(operationId, { signal })).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Outcome)),
          Effect.catchTag("ChatUnavailable", (error) =>
            signal.aborted
              ? Effect.succeed(Outcome.make({ status: "pending" }))
              : Effect.fail(error),
          ),
        );
      }),
    );
  }
}
