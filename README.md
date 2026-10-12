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
