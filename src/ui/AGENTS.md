# UI

Before UI changes, read ../../FOLDKIT.md and `.agents/skills/foldkit/SKILL.md` from the project root. Reference sources are a release-pinned Git subtree at `repos/foldkit`. Read official examples there when a convention or API is uncertain.

- Foldkit owns serializable Model, Messages, pure update/view, Commands, and Subscriptions. XState 6 with @xstate/effect owns request/retry/reconnection workflow. Pi owns durable execution. Keep these responsibilities separate.
- The XState actor has application lifetime in the runtime resources Layer. Its snapshots enter Model through a Subscription; the actor handle stays outside Model.
- `entry.ts` composes runtime resources; `main.ts` holds this small single-page program; `workflow.ts` owns actor transitions; `api.ts` is its typed HTTP adapter.
- Use official @foldkit/ui primitives via the owned foldcn components in components/ui. Add registry items with `mise run ui:add <name>`. Avoid the base setup item `@foldcn/foldcn`, whose dependency pins conflict with this coordinated package family.
- Styles use semantic Tailwind tokens in styles.css; fonts are served locally. Maintain visible focus, accessible names, mobile wrapping, and busy/error feedback.
- Test pure transitions with Story and rendered behavior with Scene. Also inspect and interact with the running browser. Use Foldkit DevTools MCP to inspect actual runtime messages/model.
- On Foldkit upgrades, update the source subtree and FOLDKIT.md together as described in docs/tooling.md, and reverify both documented DevTools patches.
