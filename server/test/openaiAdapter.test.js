import assert from "node:assert/strict";
import test from "node:test";
import { createAIAdapter } from "../services/aiProviders/openaiAdapter.js";
import { AIProviderError } from "../services/aiProviders/normalizeProviderError.js";

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const params = { systemInstruction: "System", userPrompt: "User", responseSchema: schema, maxOutputTokens: 500, timeoutMs: 3000 };

function mockClient(result) {
  const calls = [];
  return {
    calls,
    client: { responses: { create: async (...args) => { calls.push(args); return typeof result === "function" ? result(...args) : result; } } },
  };
}

test("maps normalized input to strict OpenAI Responses JSON Schema request", async () => {
  const mock = mockClient({ output_text: '{"answer":"ok"}', output: [] });
  const adapter = await createAIAdapter({ apiKey: "test-key", model: "openai-test", timeoutMs: 3000, client: mock.client });
  const result = await adapter.generate(params);
  assert.deepEqual(mock.calls[0], [{
    model: "openai-test",
    input: [{ role: "system", content: "System" }, { role: "user", content: "User" }],
    text: { format: { type: "json_schema", name: "structured_response", strict: true, schema } },
    max_output_tokens: 500,
  }, { timeout: 3000 }]);
  assert.deepEqual(result, { text: '{"answer":"ok"}', model: "openai-test", provider: "openai", refused: false, incomplete: false });
});

test("returns refusal and incomplete metadata", async () => {
  for (const [result, expected] of [
    [{ output: [{ type: "message", content: [{ type: "refusal" }] }] }, { refused: true, incomplete: false }],
    [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, { refused: false, incomplete: true }],
  ]) {
    const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(result).client });
    const actual = await adapter.generate(params);
    assert.equal(actual.refused, expected.refused);
    assert.equal(actual.incomplete, expected.incomplete);
  }
});

test("rejects empty and malformed JSON output", async () => {
  for (const result of [{ output_text: " " }, { output_text: "not-json" }]) {
    const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(result).client });
    await assert.rejects(adapter.generate(params), (error) => error instanceof AIProviderError && error.code === "invalid_output");
  }
});

test("normalizes OpenAI request failures without leaking messages", async () => {
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(async () => { throw { status: 429, message: "secret provider detail" }; }).client });
  await assert.rejects(adapter.generate(params), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.message.includes("secret provider detail"), false);
    return true;
  });
});
