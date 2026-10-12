# Cloudflare operation

Production targets **Misho@mshub.dev’s Account**, account `61de8516be4d5256c1bd7e87e8fe17ae`, through the dedicated Alchemy profile `pi-personal`. The application hostname is `pi.mshub.dev`.

## Authentication and configuration

The profile is connected. To reconnect Cloudflare, run `mise run cloudflare:profile` and select the account above. Verify it with `bun run alchemy profile show --profile pi-personal --no-input`; a Wrangler or MCP login is separate from Alchemy's profile.

Zero Trust is enabled with issuer `https://cold-wood-affc.cloudflareaccess.com`. Alchemy declares the app's Access application and an allow policy for `misho@mshub.dev`. The Worker joins that application, covering all its routes, and disables `workers.dev` and version preview URLs. Its JWT verifier also checks signature, issuer, application audience, and owner email before serving assets or API requests. Local bypass requires both Alchemy local mode and a loopback hostname.

The Access application explicitly includes its primary hostname as a public destination. Alchemy adds Worker destinations during enrollment; Cloudflare requires the primary domain to remain included in that destination list.

Production inputs live in the ignored, mode-0600 `.env.production` file:

- `ACCESS_TEAM_DOMAIN`: the HTTPS issuer above.
- `CHATGPT_CREDENTIAL`: a separate production OAuth seed. Create or reconnect it with `bun run login:chatgpt --env-file .env.production`. This does not overwrite `.dev.vars` or the local conversation's rotated credentials.
- `MODEL_ID`: optional creation default, initially `gpt-6-sol` with low reasoning effort. Existing sessions retain their persisted settings. Use the app's Model and Reasoning effort selectors to change them between turns; changes survive reloads and deployments without clearing history.

Alchemy binds `ACCESS_AUD` directly from the Access application it manages. It uploads the redacted OAuth input as a Worker secret. Missing production inputs fail deployment preparation; secret values must never enter command arguments, version control, or logs.

## Deployment

After reviewing the plan and obtaining deployment authorization:

```sh
mise run deploy
```

The task selects stage `prod`, profile `pi-personal`, and `.env.production`. The application consists of a Website Worker, static assets, a SQLite Durable Object namespace, the custom domain with managed DNS/TLS, and its Access application/policy. The browser authenticates using the account's configured Access identity provider.

Production uses Alchemy's official Cloudflare state backend. Its first-use bootstrap creates separate deployment infrastructure: the `alchemy-state-store` Worker, its Durable Object storage, and Secrets Store entries for authentication and encryption. These are in addition to the application. A first `plan` may request this bootstrap; planning is not permission to create those resources. Inspect a first-deployment plan with the same `App` declaration and `Alchemy.inMemoryState()` if the backend is not bootstrapped yet.

After deployment, verify that an unauthenticated visit requires Access login, the owner can load the app and complete a turn, and reloading retains the accepted result. Check alternate URLs remain disabled. Build and local workerd tests alone do not establish deployed behavior. Removing the domain or disabling the app's route can withdraw access without deleting conversation storage; deleting the Durable Object namespace destroys the remote conversation.

## Local and production state

`alchemy dev` uses checkout-local state and emulated storage; production starts a separate conversation. Neither deployment nor production login migrates local messages. Preserve `.alchemy`: deleting it deletes the local conversation and rotated credentials.

The compatibility date is 2026-10-08, supported by the installed runtime. Workers logs and traces are enabled. SDK errors are sanitized because provider failures may contain credentials. Custom Effect spans are not yet wired into Cloudflare tracing. No sandbox or browser products are provisioned by this application.
