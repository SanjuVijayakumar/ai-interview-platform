import assert from "node:assert/strict";
import test from "node:test";
import { createAIAdapter } from "../services/aiProviders/geminiAdapter.js";
import { AIProviderError } from "../services/aiProviders/normalizeProviderError.js";

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const params = { systemInstruction: "System", userPrompt: "User", responseSchema: schema, maxOutputTokens: 600, timeoutMs: 5000 };
const response = (value = { answer: "ok" }, candidate = { finishReason: "STOP" }) => ({
  candidates: candidate ? [candidate] : [],
  text: value === null ? undefined : JSON.stringify(value),
});

function mockClient(result) {
  const requests = [];
  return {
    requests,
    client: { models: { generateContent: async (request) => { requests.push(request); return typeof result === "function" ? result(request) : result; } } },
  };
}

test("maps system prompt, JSON schema, token limit, and timeout to Gemini request", async () => {
  const mock = mockClient(response());
  const adapter = await createAIAdapter({ apiKey: "test-key", model: "gemini-test", timeoutMs: 4000, client: mock.client });
  const result = await adapter.generate(params);
  assert.deepEqual(mock.requests[0], {
    model: "gemini-test",
    contents: "User",
    config: { systemInstruction: "System", responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 600, httpOptions: { timeout: 5000 } },
  });
  assert.deepEqual(result, { text: '{"answer":"ok"}', model: "gemini-test", provider: "gemini", refused: false, incomplete: false });
});

test("extracts safe response text and returns refusal or incomplete metadata", async () => {
  const safe = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(response()).client });
  assert.equal((await safe.generate(params)).text, '{"answer":"ok"}');

  const blocked = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient({
    promptFeedback: { blockReason: "SAFETY" }, candidates: [],
  }).client });
  assert.equal((await blocked.generate(params)).refused, true);

  const refused = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(response({ answer: "no" }, { finishReason: "PROHIBITED_CONTENT" })).client });
  assert.equal((await refused.generate(params)).refused, true);

  const incomplete = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(response(null, { finishReason: "MAX_TOKENS" })).client });
  assert.equal((await incomplete.generate(params)).incomplete, true);
});

test("rejects empty and malformed JSON without returning provider text", async () => {
  for (const result of [response(null), { text: "not-json", candidates: [{ finishReason: "STOP" }] }]) {
    const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(result).client });
    await assert.rejects(adapter.generate(params), (error) => error instanceof AIProviderError && error.code === "invalid_output");
  }
});

test("normalizes rate limits, quota exhaustion, authentication, model, timeout, and server errors", async () => {
  const cases = [
    [{ status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}' }, "quota_exhausted"],
    [{ status: 429, message: '{"error":{"message":"Rate limit exceeded"}}' }, "rate_limited"],
    [{ status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}' }, "rate_limited"],
    [{ status: 401, message: "not authorized" }, "configuration"],
    [{ status: 404, message: "model not found" }, "configuration"],
    [{ name: "AbortError" }, "timeout"],
    [{ status: 503 }, "provider_unavailable"],
  ];
  for (const [failure, expected] of cases) {
    const adapter = await createAIAdapter({ apiKey: "x", model: "m", timeoutMs: 1000, client: mockClient(async () => { throw failure; }).client });
    await assert.rejects(adapter.generate(params), (error) => error instanceof AIProviderError && error.code === expected);
  }
});

test("preserves safe Gemini diagnostics and logs provider failures without sensitive data", async () => {
  const apiKey = "DO_NOT_LOG_GEMINI_KEY_123";
  const rawMessage = `private provider response containing ${apiKey} and candidate answer`;
  const failure = {
    name: "ApiError",
    status: 429,
    message: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: rawMessage, details: [{ reason: "QUOTA_EXHAUSTED" }] } }),
  };
  const adapter = await createAIAdapter({ apiKey, model: "gemini-test-model", timeoutMs: 5000, client: mockClient(async () => { throw failure; }).client });
  const originalError = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  try {
    await assert.rejects(adapter.generate(params), (error) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, "quota_exhausted");
      assert.deepEqual(error.diagnostics, {
        provider: "gemini", errorName: "ApiError", httpStatus: 429,
        errorCategory: "quota_exhausted", timeoutMs: 5000,
        model: "gemini-test-model", providerCode: "RESOURCE_EXHAUSTED",
        attempt: 1, maxAttempts: 1, willRetry: false,
      });
      return true;
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  const record = JSON.parse(logs[0]);
  assert.deepEqual(record, {
    event: "ai_provider_request_failed", provider: "gemini", errorName: "ApiError",
    httpStatus: 429, errorCategory: "quota_exhausted", timeoutMs: 5000,
    model: "gemini-test-model", providerCode: "RESOURCE_EXHAUSTED",
    attempt: 1, maxAttempts: 1, willRetry: false,
  });
  assert.equal(logs.join(" ").includes(apiKey), false);
  assert.equal(logs.join(" ").includes(rawMessage), false);
  assert.equal(logs.join(" ").includes("candidate answer"), false);
});

test("successful Gemini requests do not log failures", async () => {
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mockClient(response()).client });
  const originalError = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  try {
    assert.equal((await adapter.generate(params)).provider, "gemini");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logs, []);
});

test("a logging failure does not replace the normalized provider error", async () => {
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mockClient(async () => { throw { status: 503, name: "ApiError" }; }).client });
  const originalError = console.error;
  console.error = () => { throw new Error("logger unavailable"); };
  try {
    await assert.rejects(adapter.generate(params), (error) => error instanceof AIProviderError && error.code === "provider_unavailable");
  } finally {
    console.error = originalError;
  }
});

function unavailableError() {
  return { name: "ApiError", status: 503, message: '{"error":{"status":"UNAVAILABLE","message":"temporarily unavailable"}}' };
}

function sequenceClient(sequence) {
  let index = 0;
  const requests = [];
  return {
    requests,
    client: { models: { generateContent: async (request) => {
      requests.push(request);
      const item = sequence[Math.min(index++, sequence.length - 1)];
      if (item instanceof Error || (item && typeof item === "object" && item.status)) throw item;
      return item;
    } } },
  };
}

async function withCapturedErrors(run) {
  const originalError = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  try { return { value: await run(), logs }; }
  finally { console.error = originalError; }
}

test("question generation returns on a successful first attempt without waiting", async () => {
  const mock = sequenceClient([response()]);
  const delays = [];
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async (ms) => delays.push(ms) });
  const result = await adapter.generate({ ...params, retry503: true });
  assert.equal(result.text, '{"answer":"ok"}');
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(delays, []);
  assert.equal(mock.requests[0].config.httpOptions.retryOptions, undefined);
  assert.equal(mock.requests[0].config.httpOptions.timeout, params.timeoutMs);
});

test("a single 503 UNAVAILABLE retries after 2 seconds and succeeds", async () => {
  const mock = sequenceClient([unavailableError(), response()]);
  const delays = [];
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async (ms) => delays.push(ms) });
  const result = await adapter.generate({ ...params, retry503: true });
  assert.equal(result.provider, "gemini");
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(delays, [2000]);
});

test("two 503 UNAVAILABLE errors retry after 2 and 4 seconds before succeeding", async () => {
  const mock = sequenceClient([unavailableError(), unavailableError(), response()]);
  const delays = [];
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async (ms) => delays.push(ms) });
  await adapter.generate({ ...params, retry503: true });
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(delays, [2000, 4000]);
  assert.ok(mock.requests.every(({ config }) => config.httpOptions.retryOptions === undefined));
});

test("three consecutive 503 UNAVAILABLE errors stop after three total attempts", async () => {
  const mock = sequenceClient([unavailableError(), unavailableError(), unavailableError()]);
  const delays = [];
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async (ms) => delays.push(ms) });
  const { logs } = await withCapturedErrors(() => assert.rejects(
    adapter.generate({ ...params, retry503: true }),
    (error) => error instanceof AIProviderError && error.code === "provider_unavailable" &&
      error.diagnostics.httpStatus === 503 && error.diagnostics.providerCode === "UNAVAILABLE",
  ));
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((line) => {
    const { attempt, maxAttempts, willRetry } = JSON.parse(line);
    return { attempt, maxAttempts, willRetry };
  }), [
    { attempt: 1, maxAttempts: 3, willRetry: true },
    { attempt: 2, maxAttempts: 3, willRetry: true },
    { attempt: 3, maxAttempts: 3, willRetry: false },
  ]);
});

test("provider failure diagnostics share a correlation ID and identify each retry attempt", async () => {
  const correlationId = "8f4c8fc6-0dce-4dc4-8c37-8fa22a18fbc1";
  const mock = sequenceClient([unavailableError(), unavailableError(), response()]);
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async () => {} });
  const { logs } = await withCapturedErrors(() => adapter.generate({ ...params, retry503: true, correlationId }));
  const records = logs.map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(({ attempt, maxAttempts, willRetry, httpStatus, errorCategory, correlationId: id }) => ({
    attempt, maxAttempts, willRetry, httpStatus, errorCategory, correlationId: id,
  })), [
    { attempt: 1, maxAttempts: 3, willRetry: true, httpStatus: 503, errorCategory: "provider_unavailable", correlationId },
    { attempt: 2, maxAttempts: 3, willRetry: true, httpStatus: 503, errorCategory: "provider_unavailable", correlationId },
  ]);
});

test("504 DEADLINE_EXCEEDED is logged as a timeout without retry", async () => {
  const correlationId = "0f9ed733-914c-4bbc-aee1-7247f55fc40b";
  const mock = sequenceClient([{ name: "ApiError", status: 504, message: '{"error":{"status":"DEADLINE_EXCEEDED","message":"provider deadline"}}' }, response()]);
  const delays = [];
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async (ms) => delays.push(ms) });
  const { logs } = await withCapturedErrors(() => assert.rejects(
    adapter.generate({ ...params, retry503: true, correlationId }),
    (error) => error instanceof AIProviderError && error.code === "timeout" && error.diagnostics.httpStatus === 504,
  ));
  const record = JSON.parse(logs[0]);
  assert.equal(record.correlationId, correlationId);
  assert.equal(record.attempt, 1);
  assert.equal(record.maxAttempts, 3);
  assert.equal(record.httpStatus, 504);
  assert.equal(record.errorCategory, "timeout");
  assert.equal(record.willRetry, false);
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(delays, []);
});

test("does not retry 429, quota, authentication, model, or invalid-output failures", async () => {
  const failures = [
    { status: 429, message: '{"error":{"status":"UNAVAILABLE","message":"rate limited"}}' },
    { status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}' },
    { status: 401, message: "unauthorized" },
    { status: 403, message: "permission denied" },
    { status: 404, message: "model not found" },
  ];
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const failure of failures) {
      const mock = sequenceClient([failure, response()]);
      const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async () => assert.fail("unexpected retry delay") });
      await assert.rejects(adapter.generate({ ...params, retry503: true }), AIProviderError);
      assert.equal(mock.requests.length, 1);
    }
  } finally {
    console.error = originalError;
  }

  const mock = sequenceClient([{ text: "not-json", candidates: [{ finishReason: "STOP" }] }, response()]);
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async () => assert.fail("unexpected retry delay") });
  await assert.rejects(adapter.generate({ ...params, retry503: true }), (error) => error.code === "invalid_output");
  assert.equal(mock.requests.length, 1);

  const refusal = sequenceClient([{ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }, response()]);
  const refusalAdapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: refusal.client, sleepFn: async () => assert.fail("unexpected retry delay") });
  assert.equal((await refusalAdapter.generate({ ...params, retry503: true })).refused, true);
  assert.equal(refusal.requests.length, 1);
});

test("does not retry if the request is cancelled during backoff", async () => {
  const mock = sequenceClient([unavailableError(), response()]);
  const controller = new AbortController();
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client, sleepFn: async () => controller.abort() });
  await assert.rejects(adapter.generate({ ...params, retry503: true, signal: controller.signal }), (error) =>
    error instanceof AIProviderError && error.code === "caller_cancelled" && error.diagnostics.errorCategory === "caller_cancelled");
  assert.equal(mock.requests.length, 1);
});

test("does not make the first Gemini request when already cancelled", async () => {
  const mock = sequenceClient([response()]);
  const controller = new AbortController();
  controller.abort();
  const adapter = await createAIAdapter({ apiKey: "x", model: "gemini-test", client: mock.client });
  await assert.rejects(adapter.generate({ ...params, retry503: true, signal: controller.signal }), (error) =>
    error instanceof AIProviderError && error.code === "caller_cancelled" && error.diagnostics.errorCategory === "caller_cancelled");
  assert.equal(mock.requests.length, 0);
});
