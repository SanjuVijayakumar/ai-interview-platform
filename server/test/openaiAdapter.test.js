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

test("logs provider failure diagnostics with correlation ID and attempt count", async () => {
  const correlationId = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const adapter = await createAIAdapter({ apiKey: "x", model: "openai-test-model", timeoutMs: 4000, client: mockClient(async () => {
    throw { status: 429, message: "rate limit" };
  }).client });

  const logs = [];
  const originalError = console.error;
  console.error = (line) => logs.push(line);
  try {
    await assert.rejects(adapter.generate({ ...params, correlationId }), AIProviderError);
  } finally {
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  const record = JSON.parse(logs[0]);
  assert.equal(record.event, "ai_provider_request_failed");
  assert.equal(record.provider, "openai");
  assert.equal(record.model, "openai-test-model");
  assert.equal(record.correlationId, correlationId);
  assert.equal(record.attempt, 1);
  assert.equal(record.maxAttempts, 1);
  assert.equal(record.willRetry, false);
  assert.equal(record.httpStatus, 429);
  assert.equal(record.errorCategory, "rate_limited");
});

test("does not make OpenAI request when already cancelled", async () => {
  const mock = mockClient({ output_text: '{"answer":"ok"}' });
  const controller = new AbortController();
  controller.abort();
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mock.client });
  await assert.rejects(adapter.generate({ ...params, signal: controller.signal }), (error) =>
    error instanceof AIProviderError && error.code === "caller_cancelled");
  assert.equal(mock.calls.length, 0);
});
