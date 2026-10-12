# Verification

## Repeatable checks

`mise run check` runs TypeScript checks, lint, application tests, isolated local-workerd integration tests, and formatting. `mise run build` compiles the frontend and a standalone Worker with Alchemy's Cloudflare plugin. `bun install --frozen-lockfile` verifies the installation and applies dependency/compiler patches. These checks require no production credentials or deployment.

Fast Bun tests live in `src`; runtime tests live in `test/runtime` and run with `mise run test:runtime`. The vendored Foldkit reference tree is excluded from both. Story/Scene tests exercise Foldkit transitions and rendered states; actor and connected workflow tests exercise submission, retry, acknowledgement ordering and cancellation. Runtime tests use Cloudflare's official Vitest integration with isolated storage and intercepted outbound requests; their assertions describe which durable and OAuth boundaries are covered.

The local-workerd suite covers credential rotation across object restarts, unchanged and changed seed behavior, concurrent real Pi refresh calls using one token exchange, duplicate accepted submission before/after restart, and recovery of interrupted accepted work through the official alarm helper before observation resumes. It also checks missing-login admission, persisted model selection, Worker asset/API authorization, request origins, JSON and streamed body limits, signed owner JWT validation, and the library's JWKS cache. External OAuth and model responses are intercepted with MSW.

Workspace runtime tests additionally cover independent conversation history/settings, idempotent creation and forking across restart, archive admission, more than 100 conversations, shared-memory revision conflicts and prompt injection/removal, cancellation and queued-work withdrawal, and the real Worker HTTP routes. Actor/bridge tests distinguish definitive rejection from uncertain delivery and keep late acknowledgements/results scoped to their thread. Story/Scene tests cover independent drafts, stale workspace responses, modal shortcuts, pending memory saves, and safe Markdown rendering.

## Manual runtime evidence

On 2026-10-12, before the subsequent cleanup, local Alchemy/workerd and an isolated browser demonstrated:

- Existing login and history survive restart.
- A real ChatGPT turn invoked `word_count` and returned the expected count.
- Discarding a real accepted POST acknowledgement, then retrying with the same operation ID, returned `accepted: false` and produced one user turn.
- Reloading during accepted work resumed observation. Killing the local Alchemy/workerd process tree and restarting against unchanged storage recovered the same operation, completed it, and left no pending work.
- Browser-only faults displayed retry and missing-login states without altering stored credentials.
- Desktop/mobile checks had no horizontal overflow; axe-core reported no violations or incomplete checks.
- Foldkit MCP discovered the live browser and read its Model through the private relay.

Those observations are historical evidence, not a substitute for rerunning affected checks after changes. Local screenshots and logs belong in ignored `.artifacts`, not in the source dependency graph.

After cleanup, local startup retained the existing login, model, and conversation. Browser checks verified latest-message positioning, following new content at the end, preserving an older reading position, bounded drafts, announced validation, and reachable controls on desktop, mobile, and short viewports. The scrolling behavior uses native CSS with chronological message order. Native mobile keyboards and other browser engines still need device coverage.

During tooling cleanup, the pinned shadcn MCP completed a real stdio initialization, listed tools, discovered `@foldcn`, and searched its textarea registry items. Its generated add-command text currently displays `[object Promise]`; use the checked-in `mise run ui:add` task to install a reviewed item. This upstream display defect does not prevent registry inspection. New MCP configuration may require restarting the development client.

On 2026-10-13, workspace feature verification used the real local app and disposable conversations. A real model turn rendered headings, lists, a table, and code; copy succeeded and Markdown export produced a downloaded file. Creating, renaming, forking, archiving, and restoring used the live Durable Object. Switching away and back preserved an unsent draft, and reloading retained the selected thread. Shared memory saved through its dialog; a simulated second-tab update produced a revision conflict while preserving the unsaved draft. The temporary memory was cleared and the test conversations archived afterward; the original history retained its 19 messages. At 375 × 667 the conversation and composer fit without horizontal overflow and the visible buttons met the 44-pixel touch target; desktop layout also fit at 1440 × 900. These checks use a desktop browser at a mobile viewport, not a native mobile keyboard.

## Limits

Compilation is not deployed-runtime verification. The alarm test explicitly dispatches Cloudflare's helper after aborting the object; it does not prove unattended deployed scheduling or an operating-system process crash. Local tests and crash recovery do not establish every crash boundary or exactly-once external billing. Mutating tools require durable idempotency. Synthetic OAuth tests do not establish production provider behavior.

Local workerd has emitted a `node:process` fallback diagnostic despite successful startup, real model requests and compilation; recheck it during runtime upgrades. Publication still requires Access configuration on the chosen hostname, private production credential delivery, explicit authorization, and an authenticated deployed smoke test. See [Cloudflare operation](cloudflare.md).
