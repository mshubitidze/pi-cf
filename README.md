# pi-cf

A private personal chat agent using Pi Durable and ChatGPT subscription authentication. One Cloudflare Worker serves the Foldkit UI and a SQLite Durable Object. Alchemy declares the infrastructure; Effect provides typed boundaries; XState 6 manages submission and reconnection.

## Run locally

```sh
mise trust
mise install
bun run login:chatgpt # first login or reconnect; opens the browser on macOS
mise run dev
```

Open the URL Alchemy prints (normally http://localhost:1337). Login writes a private `.dev.vars` seed. An existing login and local conversation survive restarts; reuse them.

Ask: “Use word_count to count: Cloudflare keeps Pi running.” Responses appear when a turn completes. Refresh resumes observation of accepted work; Retry preserves its operation ID after uncertain delivery.

## Use the workspace

- Use **New thread** for a separate conversation. The title picker searches threads and offers rename, archive, and restore. Archiving keeps the history.
- **Workspace options** contains **Fork this thread**, **Export Markdown**, and **Shared memory**. A fork copies the current conversation into an independent thread.
- Shared memory is a short, editable note used across threads for future model requests. Add preferences or context you want Pi to keep using. It is saved explicitly; Pi does not automatically extract memories. Conflicting edits preserve your draft for review.
- Model and reasoning settings apply to the selected thread. **Stop** cancels its active work; switching threads or closing the browser lets accepted work continue.
- Replies support Markdown and copying. Unsent drafts stay with their thread while the page is open. The selected thread survives reload through its URL; drafts do not survive reload.

Your original conversation remains available as **Main conversation**. This workspace uses Pi's native conversations and documents inside the existing Durable Object.

```sh
mise run check
mise run build
bun install --frozen-lockfile
```

## Project guides

- [Architecture](docs/architecture.md): ownership, persistence, OAuth, and scope.
- [Cloudflare operation](docs/cloudflare.md): private deployment requirements.
- [Agent tooling](docs/tooling.md): official sources, skills, MCP, and component registry.
- [Dependency compatibility](docs/current-dependencies.md): coupled versions and integration constraints.
- [Verification](docs/verification.md): repeatable checks and runtime limits.

The baseline comes from [cafe-stack](https://github.com/mshubitidze/cafe-stack/tree/04851db8649501bfaf8d2712429074ba0290a10f). Application code is project-specific and follows official package APIs. Owned UI styling comes from [foldcn](https://foldcn.elianiva.com), a third-party registry built on official Foldkit UI primitives.
