import assert from "node:assert/strict";
import test from "node:test";
import { createAIAdapter } from "../services/aiProviders/groqAdapter.js";
import { AIProviderError } from "../services/aiProviders/normalizeProviderError.js";

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const params = { systemInstruction: "System", userPrompt: "User", responseSchema: schema, maxOutputTokens: 500, timeoutMs: 3000 };

function mockClient(result) {
  const calls = [];
  return {
    calls,
    client: { chat: { completions: { create: async (...args) => {
      calls.push(args);
      return typeof result === "function" ? result(...args) : result;
    } } } },
  };
}

function response(content = '{"answer":"ok"}', finishReason = "stop", extra = {}) {
  return {
    choices: [{ finish_reason: finishReason, message: { content, ...extra } }],
  };
}

test("configures the OpenAI SDK for Groq with retries disabled", async () => {
  const mock = mockClient(response());
  const configurations = [];
  await createAIAdapter({
    apiKey: "groq-test-key",
    model: "openai/gpt-oss-20b",
    timeoutMs: 3000,
    clientFactory: (options) => {
      configurations.push(options);
      return mock.client;
    },
  });
  assert.deepEqual(configurations, [{
    apiKey: "groq-test-key",
    baseURL: "https://api.groq.com/openai/v1",
    timeout: 3000,
    maxRetries: 0,
  }]);
});

test("maps the adapter contract to strict Chat Completions JSON Schema", async () => {
  const mock = mockClient(response());
  const adapter = await createAIAdapter({
    apiKey: "test-key",
    model: "openai/gpt-oss-20b",
    timeoutMs: 4000,
    client: mock.client,
  });
  const result = await adapter.generate(params);
  assert.deepEqual(mock.calls[0], [{
    model: "openai/gpt-oss-20b",
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "User" },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "structured_response", strict: true, schema },
    },
    max_completion_tokens: 500,
  }, { timeout: 3000 }]);
  assert.deepEqual(result, {
    text: '{"answer":"ok"}',
    model: "openai/gpt-oss-20b",
    provider: "groq",
    refused: false,
    incomplete: false,
  });
});

test("forwards the request timeout and abort signal", async () => {
  const mock = mockClient(response());
  const controller = new AbortController();
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mock.client });
  await adapter.generate({ ...params, timeoutMs: 2200, signal: controller.signal });
  assert.deepEqual(mock.calls[0][1], { timeout: 2200, signal: controller.signal });
});

test("rejects empty and malformed JSON without returning provider content", async () => {
  for (const content of [" ", "not-json"]) {
    const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mockClient(response(content)).client });
    await assert.rejects(adapter.generate(params), (error) =>
      error instanceof AIProviderError && error.code === "invalid_output");
  }
});

test("returns incomplete and refusal metadata without exposing refusal text", async () => {
  const incomplete = await createAIAdapter({
    apiKey: "x",
    model: "m",
    client: mockClient(response('{"answer":', "length")).client,
  });
  assert.deepEqual(await incomplete.generate(params), {
    text: "", model: "m", provider: "groq", refused: false, incomplete: true,
  });

  const refusalText = "sensitive refusal details";
  const refusal = await createAIAdapter({
    apiKey: "x",
    model: "m",
    client: mockClient(response(null, "stop", { refusal: refusalText })).client,
  });
  assert.deepEqual(await refusal.generate(params), {
    text: "", model: "m", provider: "groq", refused: true, incomplete: false,
  });
  assert.equal(JSON.stringify(await refusal.generate(params)).includes(refusalText), false);

  const filtered = await createAIAdapter({
    apiKey: "x",
    model: "m",
    client: mockClient(response(null, "content_filter")).client,
  });
  assert.equal((await filtered.generate(params)).refused, true);
});

test("maps timeout failures and does not retry the request", async () => {
  const mock = mockClient(async () => {
    const error = new Error("request timed out");
    error.name = "APIConnectionTimeoutError";
    throw error;
  });
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mock.client });
  await assert.rejects(adapter.generate(params), (error) => error.code === "timeout");
  assert.equal(mock.calls.length, 1);
});

test("does not make a request when already cancelled", async () => {
  const mock = mockClient(response());
  const controller = new AbortController();
  controller.abort();
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mock.client });
  await assert.rejects(adapter.generate({ ...params, signal: controller.signal }), (error) =>
    error instanceof AIProviderError && error.code === "caller_cancelled" &&
    error.diagnostics.provider === "groq");
  assert.equal(mock.calls.length, 0);
});

test("maps mid-request cancellation to caller_cancelled", async () => {
  const controller = new AbortController();
  const mock = mockClient((_request, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  }));
  const adapter = await createAIAdapter({ apiKey: "x", model: "m", client: mock.client });
  const pending = adapter.generate({ ...params, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "caller_cancelled");
  assert.equal(mock.calls.length, 1);
});

test("normalizes Groq HTTP failures and keeps namespaced model diagnostics", async () => {
  const cases = [
    [{ status: 401, message: "invalid API key" }, "configuration"],
    [{ status: 403, message: "permission denied" }, "configuration"],
    [{ status: 404, message: "model not found" }, "configuration"],
    [{ status: 400, error: { type: "invalid_request_error" } }, "invalid_request"],
    [{ status: 400 }, "invalid_request"],
    [{ status: 429, message: "rate limit exceeded" }, "rate_limited"],
    [{ status: 429, message: "daily quota exceeded" }, "quota_exhausted"],
    [{ status: 500 }, "provider_unavailable"],
    [{ status: 502 }, "provider_unavailable"],
    [{ status: 503 }, "provider_unavailable"],
    [{ status: 504 }, "timeout"],
  ];

  for (const [failure, expected] of cases) {
    const mock = mockClient(async () => { throw failure; });
    const adapter = await createAIAdapter({
      apiKey: "x",
      model: "openai/gpt-oss-20b",
      timeoutMs: 3000,
      client: mock.client,
    });
    await assert.rejects(adapter.generate(params), (error) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, expected);
      assert.equal(error.diagnostics.provider, "groq");
      assert.equal(error.diagnostics.model, "openai/gpt-oss-20b");
      return true;
    });
    assert.equal(mock.calls.length, 1);
  }
});

test("classifies Groq HTTP 400 as invalid_request and logs only an allowlisted error type", async () => {
  const apiKey = "GROQ_SECRET_KEY_SENTINEL";
  const correlationId = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const cases = [
    [{ status: 400, error: { type: "invalid_request_error", message: `private ${apiKey}` } }, "invalid_request_error"],
    [{ status: 400, error: { message: `private ${apiKey}` } }, undefined],
    [{ status: 400, error: { type: `Bearer ${apiKey}`, message: `private ${apiKey}` } }, undefined],
  ];

  for (const [failure, expectedType] of cases) {
    const mock = mockClient(async () => { throw failure; });
    const adapter = await createAIAdapter({ apiKey, model: "openai/gpt-oss-20b", timeoutMs: 3000, client: mock.client });
    const originalError = console.error;
    const logs = [];
    console.error = (line) => logs.push(line);
    try {
      await assert.rejects(adapter.generate({ ...params, correlationId }), (error) => {
        assert.ok(error instanceof AIProviderError);
        assert.equal(error.code, "invalid_request");
        assert.equal(error.diagnostics.providerErrorType, expectedType);
        assert.equal(error.diagnostics.correlationId, correlationId);
        assert.equal(error.message.includes(apiKey), false);
        return true;
      });
    } finally {
      console.error = originalError;
    }

    assert.equal(mock.calls.length, 1);
    assert.equal(logs.length, 1);
    const diagnostic = JSON.parse(logs[0]);
    assert.equal(diagnostic.errorCategory, "invalid_request");
    assert.equal(diagnostic.httpStatus, 400);
    assert.equal(diagnostic.providerErrorType, expectedType);
    assert.equal(diagnostic.correlationId, correlationId);
    assert.equal(logs.join(" ").includes(apiKey), false);
    assert.equal(logs.join(" ").includes(failure.error?.message || ""), false);
  }
});

test("does not expose credentials or raw provider errors in failures or logs", async () => {
  const apiKey = "GROQ_SECRET_KEY_SENTINEL";
  const privateMessage = `provider body contains ${apiKey} and candidate prompt`;
  const adapter = await createAIAdapter({
    apiKey,
    model: "openai/gpt-oss-20b",
    client: mockClient(async () => {
      throw { status: 429, message: privateMessage };
    }).client,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  try {
    await assert.rejects(adapter.generate(params), (error) => {
      assert.equal(error.code, "rate_limited");
      assert.equal(error.message.includes(apiKey), false);
      assert.equal(error.message.includes(privateMessage), false);
      return true;
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs.join(" ").includes(apiKey), false);
  assert.equal(logs.join(" ").includes(privateMessage), false);
  assert.equal(logs.join(" ").includes("candidate prompt"), false);
});

test("preserves safe correlation diagnostics on provider failures", async () => {
  const correlationId = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const adapter = await createAIAdapter({
    apiKey: "x",
    model: "openai/gpt-oss-20b",
    client: mockClient(async () => { throw { status: 503 }; }).client,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(adapter.generate({ ...params, correlationId }), (error) => {
      assert.equal(error.diagnostics.correlationId, correlationId);
      assert.equal(error.diagnostics.attempt, 1);
      assert.equal(error.diagnostics.maxAttempts, 1);
      assert.equal(error.diagnostics.willRetry, false);
      return true;
    });
  } finally {
    console.error = originalError;
  }
});
