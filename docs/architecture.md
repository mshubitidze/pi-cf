# Architecture

One Cloudflare Website Worker serves the Foldkit build and `/api/*`. Every request enters Access authorization first, including static assets. A single named SQLite Durable Object (`personal`) owns the conversation and credentials. No D1, KV, R2, container, or second API Worker is needed for this slice.

| Responsibility                                           | Owner                                           |
| -------------------------------------------------------- | ----------------------------------------------- |
| View, draft, accessibility, Commands and Subscriptions   | Foldkit / official Foldkit UI / foldcn          |
| Submit, retry, reconnect and observe                     | XState 6 with @xstate/effect                    |
| Typed HTTP, schemas, service composition, scoped effects | Effect 4                                        |
| Durable accepted turns, journals, model/tool replay      | Pi Durable through Cloudflare PiHarness         |
| Startup recovery and alarms                              | Cloudflare Lifecycle installed on the native DO |
| Resource declarations and local/deployed state           | Alchemy v2                                      |

`model.ts` defines public schemas; `service.ts` is the portable conversation contract; `api.ts` decodes requests and shapes responses. `platform/cloudflare` implements identity, bindings, RPC and credentials. `ui/api.ts` supplies a typed HTTP Layer to the scoped actor in `ui/workflow.ts`. `ui/main.ts` owns the small Foldkit program, its Commands and snapshot Subscription; `ui/view.ts` renders the serializable Model using owned Foldkit UI wrappers. A synchronous dispatch lock prevents competing submit/refresh/retry intentions while IDs are generated; it releases only after both the matching acknowledgement and snapshot arrive. The actor stays outside Model.

## Durable submission

The browser generates an operation ID once. Pi persists the submission before the API acknowledges it. Retrying after a lost acknowledgement reuses that ID. Closing the page stops observation without cancelling accepted work. On load, the actor reads history and pending operations and resumes observation. The observer makes bounded waits and pauses between them; it does not rerun the agent loop.

Credential admission happens inside the Durable Object at submission; the HTTP layer does not fetch the full transcript merely to check login. `MODEL_ID` initializes a new Pi session; reads report its persisted model.

The composer exposes model and reasoning selectors. `/api/chat` projects Pi AI's credential-filtered OpenAI catalog and `getSupportedThinkingLevels`; this is the provider's known catalog, not a live account entitlement check. `/api/settings` validates the pair and calls Pi Durable's conversation `configure` once to persist both fields without resetting history. A DO admission semaphore serializes configuration with new submissions, rejecting changes while Pi has pending or active work. XState blocks competing browser actions during save; an uncertain response requires a read to reconcile before another turn. No settings are stored separately in browser storage.

Only user and assistant text is exposed in chat history. Reasoning blocks, raw tool results, credentials, and provider error bodies stay outside the public schema. An unanswered turn is surfaced as a safe error. Responses appear when a turn finishes; token streaming is not implemented yet.

The initial tool, `word_count`, is read-only and replay-safe. Future mutating tools need durable idempotency before being registered. Pi's SQLite storage owns journal schemas; application code does not invent a parallel execution journal.

## Subscription login

`scripts/login-chatgpt.mjs` uses Pi's supported interactive ChatGPT OAuth flow locally. It writes a private `.dev.vars` seed using the dotenv quoting Alchemy expects. It does not copy Codex credentials. The DO fingerprints the seed, imports it only when changed, and persists rotations under a serialized refresh lock. Restarting with the unchanged seed leaves the newer stored credential intact.

Pi 1.1.0 hides its lazy OAuth imports from bundlers. Its public `registerBunOAuthFlows()` registration makes those modules statically reachable for Worker bundles too; the Worker uses derivation/refresh only. Browser login runs locally. This integration was exercised in workerd; both development and production bundling must be rechecked on upgrades.

## Scope

This is one private conversation. There is no multi-user identity model, multi-session sidebar, coding sandbox, remote browser, file store, scheduler UI, or arbitrary tool execution. Those are later capability decisions, not implicit resources created by this example.
