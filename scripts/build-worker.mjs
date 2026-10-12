import { rolldown } from "rolldown";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";

// Compile with Alchemy's Cloudflare plugin, without plan/apply or credentials.
const bundle = await rolldown({
  input: "src/platform/cloudflare/edge.ts",
  plugins: [cloudflare({ compatibilityDate: "2026-10-08" })],
});
try {
  const result = await bundle.write({ dir: "dist/worker", format: "esm", sourcemap: true });
  console.log(`Worker bundle: ${result.output.length} modules/assets`);
} finally {
  await bundle.close();
}
