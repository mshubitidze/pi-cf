import type { AppEnv } from "../../src/platform/cloudflare/stack.ts";
import type { ConfigurableAssistant, CredentialsProbe } from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
      durableNamespaces: "Assistant" | "ConfigurableAssistant" | "CredentialsProbe";
    }
    interface Env extends AppEnv {
      MODEL_ASSISTANT: DurableObjectNamespace<ConfigurableAssistant>;
      CREDENTIALS: DurableObjectNamespace<CredentialsProbe>;
    }
  }
}
