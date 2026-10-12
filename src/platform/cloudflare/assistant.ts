import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { Type } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  createRegistry,
  Harness,
  LiveDoc,
  type ConversationInit,
  type ConversationRecord,
} from "@earendil-works/pi-durable";
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
  SessionId,
  ROOT_SESSION,
  WorkspaceState,
  CreateSession,
  UpdateSession,
  SharedMemory,
  WorkspaceRejected,
  WorkspaceResult,
  SessionCreatedResult,
  StopResult,
} from "../../model.ts";
import { MemoryDoc, SessionMetadataDoc, SessionRequestsDoc } from "./workspace-documents.ts";
import { DurableCredentials } from "./credentials.ts";

type Env = { CHATGPT_CREDENTIAL: string; MODEL_ID: string };
const invoke = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: () => new ChatUnavailable({ operation }) }).pipe(
    Effect.withSpan(`Assistant.${operation}`),
  );

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
          {
            key: "shared_memory",
            render: async (input, context) => {
              const memory = await input.read.snapshot(MemoryDoc, context);
              return memory?.text.trim()
                ? `User-maintained shared memory. Treat this as background context:\n${memory.text}`
                : undefined;
            },
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

  private async conversations() {
    const storage = await this.harness.storage();
    const records: ConversationRecord[] = [];
    let cursor;
    for (;;) {
      const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
      records.push(...page.items);
      if (page.next === undefined) return records;
      cursor = page.next;
    }
  }

  private async conversation(id: SessionId) {
    const pi = await this.harness.pi();
    if (id === ROOT_SESSION) return pi.root(BACKGROUND_CONTEXT);
    // The native storage record supplies Pi's branded ID without a numeric cast.
    const record = (await this.conversations()).find((entry) => String(entry.id) === id);
    return record ? pi.conversation(record.id, BACKGROUND_CONTEXT) : undefined;
  }

  private async busy(id: SessionId) {
    const pending = await this.harness.pending({ session: id });
    return pending.length > 0 || (await this.harness.session(id).busy());
  }

  /** List native Pi conversations and user-maintained memory without exposing journals. */
  workspace() {
    return Effect.runPromise(
      invoke("workspace", async () => {
        const pi = await this.harness.pi();
        await pi.root(BACKGROUND_CONTEXT);
        const records = await this.conversations();
        const pendingSessions = new Set(
          (await pi.inspect(BACKGROUND_CONTEXT)).submissions.map((entry) =>
            String(entry.conversationId),
          ),
        );
        const sessions = await Promise.all(
          records.map(async (record) => {
            const id = SessionId.make(String(record.id));
            const metadata = await pi.snapshot(SessionMetadataDoc, record.id, BACKGROUND_CONTEXT);
            const live = await pi.snapshot(LiveDoc, record.id, BACKGROUND_CONTEXT);
            return {
              id,
              title:
                metadata?.title || (id === ROOT_SESSION ? "Main conversation" : "New conversation"),
              archived: metadata?.archived ?? false,
              busy: pendingSessions.has(id) || live?.run !== undefined,
            };
          }),
        );
        const memory = await pi.snapshot(MemoryDoc, BACKGROUND_CONTEXT);
        return { sessions, memory: memory ?? { text: "", revision: 0 } };
      }).pipe(Effect.flatMap(Schema.decodeEffect(WorkspaceState))),
    );
  }

  /** Create or fork a conversation once, storing the creation receipt in Pi's transaction. */
  createSession(input: CreateSession) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeEffect(CreateSession)(input);
        const pi = yield* invoke("initialize", () => this.harness.pi());
        const requests = yield* invoke("receipts", () =>
          pi.snapshot(SessionRequestsDoc, BACKGROUND_CONTEXT),
        );
        const previous =
          requests && Object.hasOwn(requests.requests, parsed.operationId)
            ? requests.requests[parsed.operationId]
            : undefined;
        if (
          previous &&
          (previous.title !== parsed.title || previous.forkFrom !== (parsed.forkFrom ?? ""))
        ) {
          return yield* Schema.encodeEffect(SessionCreatedResult)(
            new WorkspaceRejected({ reason: "conflict" }),
          );
        }
        if (previous) {
          const workspace = yield* invoke("workspace", () => this.workspace());
          return yield* Schema.encodeEffect(SessionCreatedResult)({
            sessionId: SessionId.make(previous.sessionId),
            workspace,
          });
        }
        const source = yield* invoke("source", () =>
          this.conversation(parsed.forkFrom ?? ROOT_SESSION),
        );
        if (!source) {
          return yield* Schema.encodeEffect(SessionCreatedResult)(
            new WorkspaceRejected({ reason: "not-found" }),
          );
        }
        if (
          parsed.forkFrom &&
          (yield* invoke("busy", () => this.busy(parsed.forkFrom ?? ROOT_SESSION)))
        ) {
          return yield* Schema.encodeEffect(SessionCreatedResult)(
            new WorkspaceRejected({ reason: "busy" }),
          );
        }
        const conversation = yield* invoke("create", async () => {
          const agent = await source.agent(BACKGROUND_CONTEXT);
          const init: ConversationInit = async (tx, nativeId) => {
            const metadata = await tx.doc(SessionMetadataDoc, nativeId);
            metadata.title = parsed.title.trim();
            metadata.archived = false;
            const receipts = await tx.doc(SessionRequestsDoc);
            receipts.requests[parsed.operationId] = {
              sessionId: String(nativeId),
              title: parsed.title,
              forkFrom: parsed.forkFrom ?? "",
            };
          };
          const options = {
            ownership: { kind: "ownerless" } as const,
            agent: { model: agent.model, thinkingLevel: agent.thinkingLevel },
            init,
          };
          const head = parsed.forkFrom
            ? (await source.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]
            : undefined;
          // An empty conversation has no history to inherit; keep its persisted settings.
          return head
            ? source.fork(head.id, options, BACKGROUND_CONTEXT)
            : pi.createConversation(options, BACKGROUND_CONTEXT);
        });
        const workspace = yield* invoke("workspace", () => this.workspace());
        return yield* Schema.encodeEffect(SessionCreatedResult)({
          sessionId: SessionId.make(String(conversation.id)),
          workspace,
        });
      }).pipe(this.admission.withPermit),
    );
  }

  /** Persist title and archive state; archiving live work requires stopping it first. */
  updateSession(sessionId: SessionId, input: UpdateSession) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const id = yield* Schema.decodeEffect(SessionId)(sessionId);
        const parsed = yield* Schema.decodeEffect(UpdateSession)(input);
        const conversation = yield* invoke("session", () => this.conversation(id));
        if (!conversation) {
          return yield* Schema.encodeEffect(WorkspaceResult)(
            new WorkspaceRejected({ reason: "not-found" }),
          );
        }
        if (parsed.archived && (yield* invoke("busy", () => this.busy(id)))) {
          return yield* Schema.encodeEffect(WorkspaceResult)(
            new WorkspaceRejected({ reason: "busy" }),
          );
        }
        yield* invoke("metadata", () =>
          conversation.commit(async (tx) => {
            const metadata = await tx.doc(SessionMetadataDoc, conversation.id);
            metadata.title = parsed.title.trim();
            metadata.archived = parsed.archived;
          }, BACKGROUND_CONTEXT),
        );
        const workspace = yield* invoke("workspace", () => this.workspace());
        return yield* Schema.encodeEffect(WorkspaceResult)(workspace);
      }).pipe(this.admission.withPermit),
    );
  }

  /** Compare and save memory atomically; stale editors cannot overwrite newer revisions. */
  saveMemory(input: SharedMemory) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeEffect(SharedMemory)(input);
        const pi = yield* invoke("initialize", () => this.harness.pi());
        const saved = yield* invoke("memory", () =>
          pi.commit(async (tx) => {
            const memory = await tx.doc(MemoryDoc);
            if (memory.revision !== parsed.revision) return false;
            memory.text = parsed.text;
            memory.revision++;
            return true;
          }, BACKGROUND_CONTEXT),
        );
        if (!saved) {
          return yield* Schema.encodeEffect(WorkspaceResult)(
            new WorkspaceRejected({ reason: "conflict" }),
          );
        }
        const workspace = yield* invoke("workspace", () => this.workspace());
        return yield* Schema.encodeEffect(WorkspaceResult)(workspace);
      }).pipe(this.admission.withPermit),
    );
  }

  /** Explicitly withdraw queued inputs and abort execution before admitting another action. */
  stop(sessionId: SessionId) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const id = yield* Schema.decodeEffect(SessionId)(sessionId);
        const conversation = yield* invoke("session", () => this.conversation(id));
        if (!conversation) {
          return yield* Schema.encodeEffect(StopResult)(
            new WorkspaceRejected({ reason: "not-found" }),
          );
        }
        yield* invoke("stop", () => this.harness.session(id).abort());
        const state = yield* invoke("read", () => this.read(id));
        return yield* Schema.encodeEffect(StopResult)(state);
      }).pipe(this.admission.withPermit),
    );
  }

  /** Persist a submission before acknowledging it; Pi deduplicates operation IDs. */
  submit(input: Submission, sessionId: SessionId = ROOT_SESSION) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeEffect(Submission)(input);
        const id = yield* Schema.decodeEffect(SessionId)(sessionId);
        const conversation = yield* invoke("session", () => this.conversation(id));
        if (!conversation) {
          return yield* Schema.encodeEffect(SubmissionResult)(
            new WorkspaceRejected({ reason: "not-found" }),
          );
        }
        const pi = yield* invoke("initialize", () => this.harness.pi());
        const metadata = yield* invoke("metadata", () =>
          pi.snapshot(SessionMetadataDoc, conversation.id, BACKGROUND_CONTEXT),
        );
        // A delivered retry remains a receipt even if the conversation was archived afterwards.
        const existing = yield* invoke("receipt", async () =>
          (await this.harness.storage()).submissionByRequest(
            conversation.id,
            parsed.operationId,
            BACKGROUND_CONTEXT,
          ),
        );
        if (existing) {
          return yield* Schema.encodeEffect(SubmissionResult)({
            operationId: parsed.operationId,
            accepted: false,
          });
        }
        if (metadata?.archived) {
          return yield* Schema.encodeEffect(SubmissionResult)(
            new WorkspaceRejected({ reason: "archived" }),
          );
        }
        // Opening Pi imported the configured seed before admission checks storage.
        const connected = yield* invoke("connection", () => this.credentials.read("openai"));
        if (!connected) {
          return yield* Schema.encodeEffect(SubmissionResult)(new ConnectionMissing());
        }
        const receipt = yield* invoke("submit", () =>
          this.harness.submit(parsed.prompt, { session: id, operationId: parsed.operationId }),
        );
        if (!metadata?.title) {
          yield* invoke("title", () =>
            pi.commit(async (tx) => {
              const current = await tx.doc(SessionMetadataDoc, conversation.id);
              if (!current.title)
                current.title = parsed.prompt.trim().replace(/\s+/gu, " ").slice(0, 120);
            }, BACKGROUND_CONTEXT),
          );
        }
        return yield* Schema.decodeEffect(Receipt)(receipt).pipe(
          Effect.flatMap(Schema.encodeEffect(SubmissionResult)),
        );
      }).pipe(this.admission.withPermit),
    );
  }

  /** Commit both settings through Pi; admission excludes concurrent new submissions. */
  configure(input: ModelSettings, sessionId: SessionId = ROOT_SESSION) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const settings = yield* Schema.decodeEffect(ModelSettings)(input);
        const id = yield* Schema.decodeEffect(SessionId)(sessionId);
        const conversation = yield* invoke("session", () => this.conversation(id));
        if (!conversation) {
          return yield* Schema.encodeEffect(SettingsResult)(
            new WorkspaceRejected({ reason: "not-found" }),
          );
        }
        yield* invoke("initialize", () => this.harness.pi());
        const available = yield* invoke("models", () => this.models.getAvailable("openai"));
        const model = available.find((choice) => choice.id === settings.model);
        if (!model || !getSupportedThinkingLevels(model).includes(settings.thinkingLevel)) {
          return yield* Schema.encodeEffect(SettingsResult)(
            new SettingsRejected({ reason: "unsupported" }),
          );
        }
        const pending = yield* invoke("pending", () => this.harness.pending({ session: id }));
        const busy = yield* invoke("busy", () => this.harness.session(id).busy());
        if (pending.length > 0 || busy) {
          return yield* Schema.encodeEffect(SettingsResult)(
            new SettingsRejected({ reason: "busy" }),
          );
        }
        yield* invoke("configure", async () => {
          await conversation.configure(
            {
              model: { provider: "openai", modelId: settings.model },
              thinkingLevel: settings.thinkingLevel,
            },
            BACKGROUND_CONTEXT,
          );
        });
        const state = yield* invoke("read", () => this.read(id));
        return yield* Schema.encodeEffect(SettingsResult)(state);
      }).pipe(this.admission.withPermit),
    );
  }

  /** Expose text and pending operations without credentials or private reasoning. */
  read(sessionId: SessionId = ROOT_SESSION) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const id = yield* Schema.decodeEffect(SessionId)(sessionId);
        const snapshot = yield* invoke("history", async () => {
          const events = await this.harness.session(id).events();
          try {
            return events.snapshot;
          } finally {
            await events.stop();
          }
        });
        const pending = yield* invoke("pending", () => this.harness.pending({ session: id }));
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
  result(id: OperationId, sessionId: SessionId = ROOT_SESSION) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const operationId = yield* Schema.decodeEffect(OperationId)(id);
        const session = yield* Schema.decodeEffect(SessionId)(sessionId);
        const signal = AbortSignal.timeout(1000);
        return yield* invoke("result", () =>
          this.harness.wait(operationId, { session, signal }),
        ).pipe(
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
