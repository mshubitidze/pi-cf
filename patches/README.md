# Dependency patches

Bun applies these patches on install through `patchedDependencies` in `package.json`. Each patch is tied to an exact version. When you upgrade a patched package, check whether upstream fixed the problem. Then either drop the patch or recreate it with `mise run patch <pkg>` and `mise run patch:commit <pkg>`, and update this file.

Every patch needs an entry here. Inside the patched code, mark the change with a `PATCH:` comment.

## Foldkit DevTools MCP reconnect loop under `alchemy dev`

Patches `@foldkit/vite-plugin@0.27.1` and `@foldkit/devtools-mcp@0.24.1`.

**Symptom.** Under `alchemy dev`, every agent session's Foldkit DevTools MCP server connected to the relay and disconnected many times per second. The MCP tools were unusable, and the dev server log filled with `MCP client connected` and `MCP client disconnected` lines.

**Cause.** Two upstream behaviors combine:

1. `@foldkit/vite-plugin` hosts its MCP relay at `/__foldkit/devtools-mcp` on Vite's own `httpServer`. Alchemy's Cloudflare Vite integration (`handleWebSocket` in `@alchemy.run/cloudflare-runtime`, `src/vite/websockets.ts`) adds its own `upgrade` listener to the same server. That listener forwards every upgrade whose `sec-websocket-protocol` doesn't start with `vite` to workerd. The worker answers with a non-101 response, so Alchemy destroys the socket Foldkit has already accepted. The client sees the connection open and then close with code 1006 about 20 ms later.
2. `@foldkit/devtools-mcp` only backs off when an open fails. When a socket opens and then closes, it reconnects immediately, so (1) turns into a tight loop.

**Patches.**

- `@foldkit/vite-plugin`: `startMcpRelay` always uses `bindLoopbackRelay`, which is a token-protected listener on its own `127.0.0.1` port, published to the relay registry. The relay no longer attaches to Vite's `httpServer`, so Alchemy's upgrade listener never sees it. The fixed `devToolsMcpPort` path is unchanged.
- `@foldkit/devtools-mcp`: in `webSocketClient.js`, a connection that closes within 5 seconds of opening counts as a failure. Reconnects then back off exponentially, from 0.5 s up to 30 s. A connection that stays up longer resets the backoff.

**Remove independently:** the relay patch addresses the demonstrated Alchemy incompatibility. Remove it when Foldkit isolates its relay or Alchemy no longer forwards another listener's upgrades; verify a stable live MCP connection under `alchemy dev`.

The backoff patch is a separate defensive choice, not a requirement once the relay is isolated. Upstream still reconnects immediately after short-lived successful connections. Keep it to bound reconnect attempts if that failure recurs; remove it when upstream backs off that path, and verify disconnect/reconnect behavior.
