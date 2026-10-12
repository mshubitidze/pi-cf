import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/runtime/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          ASSISTANT: { className: "Assistant", useSQLite: true },
          MODEL_ASSISTANT: { className: "ConfigurableAssistant", useSQLite: true },
          CREDENTIALS: { className: "CredentialsProbe", useSQLite: true },
        },
        bindings: {
          CHATGPT_CREDENTIAL: "",
          MODEL_ID: "gpt-6-sol",
          LOCAL_DEV: "true",
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          OWNER_EMAIL: "test@example.invalid",
        },
        serviceBindings: {
          ASSETS: () => new Response("test asset"),
        },
      },
    }),
  ],
  test: {
    // Workers cannot read Vitest's host-side filesystem module cache.
    fsModuleCache: false,
    include: ["test/runtime/**/*.test.ts"],
    setupFiles: ["./test/runtime/setup.ts"],
    testTimeout: 20_000,
  },
});
