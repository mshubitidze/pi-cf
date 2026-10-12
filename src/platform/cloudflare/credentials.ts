import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const OAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.NonEmptyString,
  refresh: Schema.NonEmptyString,
  expires: Schema.Finite,
  clientId: Schema.NonEmptyString,
  scopes: Schema.optional(Schema.Array(Schema.String)),
});
class CredentialFailure extends Schema.TaggedError<CredentialFailure>()("CredentialFailure", {
  operation: Schema.String,
}) {}
const io = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: () => new CredentialFailure({ operation }) });

/** One DO owns the credential, including serialized refreshes and durable rotation. */
export class DurableCredentials implements CredentialStore {
  private readonly mutex = Semaphore.makeUnsafe(1);
  constructor(private readonly storage: DurableObjectStorage) {}

  /** A seed fingerprint prevents a restart from replacing a freshly rotated token. */
  readonly initialize = Effect.fn("Credentials.initialize")(function* (
    this: DurableCredentials,
    seed: Redacted.Redacted<string>,
  ) {
    const raw = Redacted.value(seed);
    if (!raw) {
      return;
    }
    const credential = yield* Schema.decodeEffect(Schema.fromJsonString(OAuth))(raw).pipe(
      Effect.mapError(() => new CredentialFailure({ operation: "decode seed" })),
    );
    const digest = yield* io("fingerprint", () =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    yield* io("initialize", () =>
      this.storage.transaction(async (transaction) => {
        if ((await transaction.get("oauth-seed")) !== fingerprint) {
          await transaction.put({ "oauth:openai": credential, "oauth-seed": fingerprint });
        }
      }),
    );
  });

  private readonly readEffect = Effect.fn("Credentials.read")(function* (
    this: DurableCredentials,
    id: string,
  ) {
    const value = yield* io("read", () => this.storage.get<unknown>(`oauth:${id}`));
    if (value === undefined) {
      return undefined;
    }
    return yield* Schema.decodeUnknownEffect(OAuth)(value).pipe(
      Effect.mapError(() => new CredentialFailure({ operation: "decode stored credential" })),
    );
  });

  /** Pi's Promise contract is translated at this SDK boundary. */
  read(id: string) {
    return Effect.runPromise(this.readEffect(id));
  }
  /** List provider metadata without returning tokens. */
  list() {
    return Effect.runPromise(
      this.readEffect("openai").pipe(
        Effect.map((value) => (value ? [{ providerId: "openai", type: value.type }] : [])),
      ),
    );
  }
  /** Hold the instance lock across refresh and persistence, never a storage transaction. */
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readEffect(id);
        const next = yield* io("refresh", () => fn(current));
        if (next !== undefined) {
          const parsed = yield* Schema.decodeUnknownEffect(OAuth)(next).pipe(
            Effect.mapError(() => new CredentialFailure({ operation: "decode rotation" })),
          );
          yield* io("persist rotation", () => this.storage.put(`oauth:${id}`, parsed));
        }
        return next ?? current;
      }).pipe(this.mutex.withPermit),
    );
  }
  /** Removing credentials participates in the same refresh lock. */
  delete(id: string) {
    return Effect.runPromise(
      io("delete", () => this.storage.delete(`oauth:${id}`)).pipe(
        Effect.asVoid,
        this.mutex.withPermit,
      ),
    );
  }
}
