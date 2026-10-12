import { setupNetwork } from "@msw/cloudflare";
import { reset } from "cloudflare:test";
import { afterAll, afterEach, beforeAll } from "vitest";

export const network = setupNetwork();
network.configure({ context: { quiet: true }, onUnhandledFrame: "error" });
beforeAll(() => network.enable());
afterEach(async () => {
  await reset();
  network.resetHandlers();
});
afterAll(() => network.disable());
