# Personal Pi

Private single-user Cloudflare agent. Read README.md for running it and docs/architecture.md before changing ownership or persistence.

- Use Context7 for current library/API documentation: resolve the library first, then query one concept at a time. Check results against installed source when versions differ.
- Bun and mise own tools and tasks. Run `mise run check` and `mise run build` before finishing implementation work; inspect the real browser for UI changes.
- Prefer current compatible releases, including prereleases. Pin coupled versions together. Actual compatibility constraints belong in docs/current-dependencies.md.
- Canonical skills are in `.agents/skills`; `.claude/skills` links there. Read docs/tooling.md for source updates, MCP setup, and provenance.
- Prefer upstream tooling setup. Retain project-specific adapters for demonstrated gaps, with their reason and removal condition; a handoff or example repository alone is not justification.
- UI changes: follow src/ui/AGENTS.md and the official Foldkit skill. XState 6 is the explicitly selected workflow dependency.
- Cloudflare/Pi changes: follow src/platform/cloudflare/AGENTS.md. Keep platform imports out of portable model, service, HTTP, and UI code.
- Use Effect services, Schema boundaries, tagged failures, and named Effect operations. Native SDK promises belong at adapters. Keep secrets redacted and provider failures out of HTTP bodies and logs.
- Preserve durable operation IDs across retries. A browser disconnect stops observation, not accepted execution. Keep persisted keys and replay contracts compatible or write a migration.
- Test behavior at its actual boundary: Story/Scene for UI, XState actors for workflow, and local workerd for Durable Objects, replay, OAuth, and persistence. Unit tests alone do not prove runtime integration.
- Apply dependency patches through `mise run patch` / `patch:commit`; document each in patches/README.md and reverify on upgrades.
- Keep credentials, local state, and generated artifacts ignored. Never display `.dev.vars`, `.local/host.json`, or OAuth values.
- Deployment, shared access-control changes, publication, and destructive actions need explicit user authorization. Local implementation and disposable verification are authorized.
