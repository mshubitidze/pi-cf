import { DurableObject } from "cloudflare:workers";
import { Assistant } from "../../src/platform/cloudflare/assistant.ts";
import { modelDefault } from "./fixtures.ts";
import { DurableCredentials } from "../../src/platform/cloudflare/credentials.ts";

export { default, Assistant } from "../../src/platform/cloudflare/edge.ts";

/** A real SQLite host for the credential adapter, without a Pi session. */
export class CredentialsProbe extends DurableObject {
  readonly credentials = new DurableCredentials(this.ctx.storage);
}

/** Uses the production class and durable namespace across a binding-only change. */
export class ConfigurableAssistant extends Assistant {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, { ...env, MODEL_ID: modelDefault.id });
  }
}
