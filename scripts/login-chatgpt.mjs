import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const { values } = parseArgs({ options: { "env-file": { type: "string", default: ".dev.vars" } } });
const envFile = values["env-file"];

// This login creates a dedicated app session. Never reuse ~/.codex/auth.json.
await mkdir(".local", { recursive: true, mode: 0o700 });
let deviceId;
try {
  deviceId = JSON.parse(await readFile(".local/host.json", "utf8")).deviceId;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  deviceId = randomUUID();
  await writeFile(".local/host.json", JSON.stringify({ deviceId }), { mode: 0o600 });
}
const credentials = new InMemoryCredentialStore();
const models = createModels({ credentials });
models.setProvider(openaiProvider());
try {
  const credential = await models.login(
    "openai",
    "oauth",
    {
      signal: AbortSignal.timeout(10 * 60 * 1000),
      notify(event) {
        if (event.type === "auth_url") {
          console.log("Opening ChatGPT sign-in in your browser. Approve access for pi-cf.");
          execFile("open", [event.url], (error) => {
            if (error)
              console.error(
                "Could not open the browser automatically. Retry from a desktop terminal.",
              );
          });
        }
        if (event.type === "progress") console.log("Completing ChatGPT connection…");
      },
      prompt(prompt) {
        // Local callback delivers the result. Do not paste OAuth codes into chat.
        return new Promise((_, reject) => {
          const cancel = () => reject(new Error("Login cancelled"));
          if (prompt.signal?.aborted) cancel();
          else prompt.signal?.addEventListener("abort", cancel, { once: true });
        });
      },
    },
    { getDeviceId: () => deviceId, agentName: "pi-cf" },
  );
  const line = "CHATGPT_CREDENTIAL='" + JSON.stringify(credential) + "'";
  let existing = "";
  try {
    existing = await readFile(envFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rest = existing
    .split("\n")
    .filter((line) => line && !line.startsWith("CHATGPT_CREDENTIAL="))
    .join("\n");
  await writeFile(envFile, [rest, line, ""].filter(Boolean).join("\n") + "\n", { mode: 0o600 });
  await chmod(envFile, 0o600);
  console.log(
    `ChatGPT connected. Credentials saved privately in ${envFile}. Restart local development or redeploy the corresponding environment to import the new login.`,
  );
} catch {
  console.error(
    "ChatGPT login did not complete. Check the browser, account eligibility, and whether port 1455 is occupied; then run bun run login:chatgpt again.",
  );
  process.exitCode = 1;
}
