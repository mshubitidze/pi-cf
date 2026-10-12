# Cloudflare boundary

Read the project skills agents-sdk, durable-objects, and workers-best-practices for their corresponding changes. Verify PiHarness/Lifecycle APIs against installed agents source and Pi credential contracts against installed pi-ai source.

- `stack.ts` declares one Website Worker with static assets and one SQLite Durable Object binding. The Assistant import there must remain type-only: plan-time Bun cannot load cloudflare:workers.
- `edge.ts` verifies Access before either assets or API, checks write origins, and builds the portable HTTP service. Deployed requests fail closed without Access configuration; the local bypass requires both LOCAL_DEV and a loopback hostname.
- `assistant.ts` is the native DO lifecycle host. PiHarness owns Pi journals, startup recovery, and alarms. Do not add another execution state machine around Pi.
- `credentials.ts` seeds OAuth once per changed seed and serializes refresh/persistence. Rotated credentials belong to the DO. Restarting must never overwrite them with the old seed.
- Interactive ChatGPT login runs only in scripts/login-chatgpt.mjs. Pi's public bundled OAuth registration makes token derivation/refresh reachable in the Worker bundle; validate both dev and production build when changing it.
- Keep platform observability enabled. Log safe operation/category metadata only; SDK errors can contain response bodies and credentials.
- Follow docs/cloudflare.md before deploying. The selected account is the user's personal account. Never change it implicitly.
