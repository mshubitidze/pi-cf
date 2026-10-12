# Agent tooling

`.agents/skills` is the shared discovery path; `.claude/skills` links to it. Root and scoped `AGENTS.md` files contain project-specific instructions. Development hosts are optional: the repository's commands work independently of T3, Codex, Claude, or Amp.

## Official sources and skills

Foldkit's source is a release-pinned Git subtree at `repos/foldkit`, following its [official source workflow](https://foldkit.dev/ai/overview). The `foldkit`, `generate-program`, and `audit-program` skill directories link to that source. When resolving source-relative paths such as `${CLAUDE_SKILL_DIR}/../../examples`, use the physical skill directory under `repos/foldkit/skills`; its adjacent examples and packages are included in the subtree. `FOLDKIT.md` is the matching application template.

The subtree currently tracks `foldkit@0.168.0`, commit `060271955cc2fdd34ddb5e17a64b6662268f79c5`. To upgrade it alongside the installed Foldkit family:

```sh
git subtree pull --prefix=repos/foldkit https://github.com/foldkit/foldkit.git foldkit@<version> --squash
```

Refresh `FOLDKIT.md` from the matching template and recheck dependency compatibility and [patches](../patches/README.md). The subtree's source and license files are reference material, excluded from application build/test tasks.

The three self-contained Cloudflare skills (`agents-sdk`, `durable-objects`, `workers-best-practices`) are official copies from [cloudflare/skills at d7de3907f8ed32b23a6a71beeb2a0c774dfef4e1](https://github.com/cloudflare/skills/tree/d7de3907f8ed32b23a6a71beeb2a0c774dfef4e1). Their license is retained in `.agents/licenses`. Cloudflare recommends native plugins where supported and also documents [clone/copy installation](https://github.com/cloudflare/skills#installing). This project chooses checked-in copies so a checkout carries its reviewed guidance without requiring a host plugin. To update, copy these skill directories and their referenced files from a temporary upstream checkout, retain the license, and record the reviewed commit here. A permanent `repos/cloudflare-skills` checkout serves no purpose.

## MCP

`.mcp.json`, `.codex/config.toml`, and `.amp/settings.json` configure the same two servers in each client's native format. Clients must trust/load project configuration and may need a restart to discover newly configured tools. Context7 is supplied by the development host; its credentials and global settings stay outside this repository.

**Foldkit DevTools:** clients invoke the installed `foldkit-devtools-mcp` binary through Bun. The official server discovers the project from its working directory; start clients in the project root. Each client's native `env` configuration selects `.local/foldkit-relays`, matching Vite and avoiding dependence on host-specific temporary directories. This is a project choice using the [supported relay-directory setting](https://foldkit.dev/ai/mcp), not an extra launcher. Relay records contain authentication material and remain private and ignored. Run `mise run dev`, open the application, then inspect its Model and Messages through MCP. The [documented patches](../patches/README.md) isolate the relay from Alchemy's WebSocket listener and back off failed reconnects.

**shadcn:** clients run `bun run --bun shadcn mcp`, using the same exact local CLI version and Bun runtime as `mise run ui:add`. The official [MCP server](https://ui.shadcn.com/docs/mcp) reads custom registries from `components.json`. It supplies registry discovery and inspection; it is not a runtime UI dependency.

## UI registry

`components.json` points to `@foldcn`, whose components target Foldkit. shadcn's [registry format supports other frameworks](https://ui.shadcn.com/docs/registry); its default React component implementations are not used here. Add only a component the application needs:

```sh
mise run ui:add <name>
```

Review generated changes before retaining them. Skip the base setup item `@foldcn/foldcn`: its Effect/Foldkit dependency pins conflict with this project's coordinated family. `rsc: false` avoids React Server Component directives. Keep the CLI's default `tsx` transform setting; changing it also rewrites TypeScript registry items to JavaScript. The official shadcn skill assumes React primitives, so the project uses official Foldkit skills for implementation instead.
