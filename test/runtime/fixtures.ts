/** Public, synthetic credentials; no developer login or local state is loaded. */
export const credential = (access: string, expires = Date.now() + 3_600_000) => ({
  type: "oauth" as const,
  access,
  refresh: `refresh-${access}`,
  expires,
  clientId: "synthetic-test-client",
  scopes: ["chatgpt.tokens.use.direct"],
});

/** A minimal successful OpenAI Responses SSE exchange, parsed by the real Pi provider. */
export const responseStream = (text: string) => {
  const item = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_test", status: "completed", output: [item] },
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
};

/** Simulates a binding-only deployment change when a test DO is reconstructed. */
export const modelDefault = { id: "gpt-6-sol" };
