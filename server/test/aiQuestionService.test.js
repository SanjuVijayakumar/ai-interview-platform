import assert from "node:assert/strict";
import test from "node:test";
import { AIProviderConfigurationError } from "../config/aiProvider.js";
import { AIProviderError } from "../services/aiProviders/normalizeProviderError.js";
import {
  AIQuestionConfigurationError,
  AIQuestionResponseError,
  generateInterviewQuestions,
} from "../services/aiQuestionService.js";

const input = {
  candidate: { skills: ["JavaScript", "Node.js"], experience: 4, targetRole: "Backend Engineer" },
  interview: { title: "Backend Interview", category: "Technical", difficulty: "Intermediate" },
  preferences: { count: 2, difficulty: "Advanced", category: "APIs" },
};

const validQuestions = [
  { questionText: "How would you design an idempotent API endpoint?", category: "APIs", difficulty: "Advanced", expectedAnswer: "Use a stable idempotency key and persist the result for safe retries." },
  { questionText: "How do you isolate failures in a Node.js service?", category: "APIs", difficulty: "Advanced", expectedAnswer: "Use timeouts, bounded retries, circuit breakers, and observable failure boundaries." },
];

function fakeProvider({ provider = "gemini", text = JSON.stringify({ questions: validQuestions }), refused = false, incomplete = false, error } = {}) {
  const calls = [];
  const adapter = {
    provider,
    model: `${provider}-mock-model`,
    timeoutMs: 3210,
    async generate(request) {
      calls.push(request);
      if (error) throw error;
      return { text, provider, model: this.model, refused, incomplete };
    },
  };
  return { calls, providerFactory: async () => adapter };
}

test("uses Gemini by default through the provider factory and preserves successful question data", async () => {
  const fake = fakeProvider();
  const questions = await generateInterviewQuestions(input, { providerFactory: fake.providerFactory });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].systemInstruction, "You generate high-quality interview practice questions.");
  assert.equal(fake.calls[0].maxOutputTokens, 3000);
  assert.equal(fake.calls[0].timeoutMs, 3210);
  assert.equal(fake.calls[0].retry503, true);
  assert.equal(fake.calls[0].responseSchema.properties.questions.type, "array");
  assert.match(fake.calls[0].userPrompt, /Skills: JavaScript, Node\.js/);
  assert.match(fake.calls[0].userPrompt, /Experience: 4 years/);
  assert.match(fake.calls[0].userPrompt, /Target role: Backend Engineer/);
  assert.match(fake.calls[0].userPrompt, /Difficulty: Advanced/);
  assert.match(fake.calls[0].userPrompt, /Question category: APIs/);
  assert.deepEqual(questions, validQuestions);
});

test("supports explicitly selected Gemini and optional OpenAI adapters through the same interface", async () => {
  for (const provider of ["gemini", "openai"]) {
    const fake = fakeProvider({ provider });
    const questions = await generateInterviewQuestions(input, { providerFactory: fake.providerFactory });
    assert.equal(questions.length, input.preferences.count);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].retry503, provider === "gemini");
  }
});

test("forwards request cancellation to one Gemini generation call", async () => {
  const fake = fakeProvider();
  const controller = new AbortController();
  await generateInterviewQuestions(input, { providerFactory: fake.providerFactory, signal: controller.signal });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].signal, controller.signal);
  assert.equal(fake.calls[0].retry503, true);
});

test("assigns different correlation IDs to separate requests and logs safe final outcomes", async () => {
  const safeInput = {
    ...input,
    candidate: { ...input.candidate, skills: ["PRIVATE_USER_SKILL_SENTINEL"] },
  };
  const first = fakeProvider();
  const second = fakeProvider();
  const originalInfo = console.info;
  const logs = [];
  console.info = (line) => logs.push(line);
  try {
    await generateInterviewQuestions(safeInput, { providerFactory: first.providerFactory });
    await generateInterviewQuestions(safeInput, { providerFactory: second.providerFactory });
  } finally {
    console.info = originalInfo;
  }

  const firstId = first.calls[0].correlationId;
  const secondId = second.calls[0].correlationId;
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(secondId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(firstId, secondId);
  const records = logs.map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ correlationId, outcome }) => ({ correlationId, outcome })), [
    { correlationId: firstId, outcome: "success" },
    { correlationId: secondId, outcome: "success" },
  ]);
  assert.equal(logs.join(" ").includes("PRIVATE_USER_SKILL_SENTINEL"), false);
  assert.equal(logs.join(" ").includes(validQuestions[0].questionText), false);
});

test("caller cancellation is logged as cancelled rather than timeout", async () => {
  const fake = fakeProvider({ error: new AIProviderError("caller_cancelled") });
  const originalInfo = console.info;
  const logs = [];
  console.info = (line) => logs.push(line);
  try {
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), { name: "AIQuestionCancelledError" });
  } finally {
    console.info = originalInfo;
  }
  const record = JSON.parse(logs[0]);
  assert.equal(record.outcome, "cancelled");
  assert.equal(record.errorCategory, "caller_cancelled");
  assert.notEqual(record.errorCategory, "timeout");
});

test("rejects missing questions, incorrect counts, missing fields, blank text, invalid difficulty, and short expected answers", async () => {
  const invalidResponses = [
    {},
    { questions: [validQuestions[0]] },
    { questions: [{ ...validQuestions[0], category: undefined }, validQuestions[1]] },
    { questions: [{ ...validQuestions[0], questionText: " " }, validQuestions[1]] },
    { questions: [{ ...validQuestions[0], difficulty: "Expert" }, validQuestions[1]] },
    { questions: [{ ...validQuestions[0], expectedAnswer: "too short" }, validQuestions[1]] },
  ];
  for (const body of invalidResponses) {
    const fake = fakeProvider({ text: JSON.stringify(body) });
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), AIQuestionResponseError);
  }
});

test("rejects duplicate questions after whitespace and case normalization", async () => {
  const duplicates = [validQuestions[0], { ...validQuestions[1], questionText: "  HOW WOULD YOU DESIGN AN IDEMPOTENT API ENDPOINT? " }];
  const fake = fakeProvider({ text: JSON.stringify({ questions: duplicates }) });
  await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), AIQuestionResponseError);
});

test("rejects malformed JSON and empty provider responses", async () => {
  for (const text of ["{bad json", " "]) {
    const fake = fakeProvider({ text });
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), AIQuestionResponseError);
  }
  await assert.rejects(generateInterviewQuestions(input, {
    providerFactory: async () => ({ generate: async () => ({ text: "" }) }),
  }), AIQuestionResponseError);
});

test("maps configuration, rate limit, quota, timeout, and provider errors safely", async () => {
  const cases = [
    [new AIProviderConfigurationError("private token not shown"), AIQuestionConfigurationError, undefined],
    [new AIProviderError("configuration"), AIQuestionConfigurationError, undefined],
    [new AIProviderError("rate_limited"), Error, "AIQuestionRateLimitError"],
    [new AIProviderError("quota_exhausted"), Error, "AIQuestionProviderError"],
    [new AIProviderError("timeout"), Error, "AIQuestionTimeoutError"],
    [new AIProviderError("provider_unavailable"), Error, "AIQuestionProviderError"],
  ];
  for (const [failure, type, name] of cases) {
    const fake = fakeProvider({ error: failure });
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), (error) => {
      assert.equal(error instanceof type, true);
      if (name) assert.equal(error.name, name);
      assert.equal(error.message.includes("private token"), false);
      return true;
    });
  }
});

test("maps refusal and incomplete responses to existing response errors", async () => {
  for (const flags of [{ refused: true }, { incomplete: true }]) {
    const fake = fakeProvider(flags);
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), AIQuestionResponseError);
  }
});

test("all attempts within one request use the same correlation ID across attempt failures and final outcome", async () => {
  const errorLogs = [];
  const infoLogs = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (line) => errorLogs.push(line);
  console.info = (line) => infoLogs.push(line);

  const fakeAdapter = {
    provider: "gemini",
    model: "gemini-test-model",
    timeoutMs: 5000,
    async generate({ correlationId }) {
      const err = new AIProviderError("provider_unavailable", undefined, {
        provider: "gemini",
        model: "gemini-test-model",
        correlationId,
        attempt: 1,
        maxAttempts: 1,
        httpStatus: 503,
        errorCategory: "provider_unavailable",
        willRetry: false,
      });
      console.error(JSON.stringify({ event: "ai_provider_request_failed", ...err.diagnostics }));
      throw err;
    },
  };

  try {
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: async () => fakeAdapter }), { name: "AIQuestionProviderError" });
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }

  assert.equal(errorLogs.length, 1);
  assert.equal(infoLogs.length, 1);
  const errorRecord = JSON.parse(errorLogs[0]);
  const infoRecord = JSON.parse(infoLogs[0]);

  assert.ok(infoRecord.correlationId);
  assert.equal(errorRecord.correlationId, infoRecord.correlationId);
  assert.equal(infoRecord.outcome, "failure");
  assert.equal(infoRecord.errorCategory, "provider_unavailable");
  assert.equal(infoRecord.httpStatus, 503);
});

test("final failure outcome logs normalized error category and HTTP status", async () => {
  const infoLogs = [];
  const originalInfo = console.info;
  console.info = (line) => infoLogs.push(line);
  const fake = fakeProvider({
    error: new AIProviderError("rate_limited", undefined, {
      provider: "gemini",
      httpStatus: 429,
      errorCategory: "rate_limited",
    }),
  });
  try {
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), { name: "AIQuestionRateLimitError" });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(infoLogs.length, 1);
  const record = JSON.parse(infoLogs[0]);
  assert.equal(record.outcome, "failure");
  assert.equal(record.errorCategory, "rate_limited");
  assert.equal(record.httpStatus, 429);
  assert.match(record.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("a 504 timeout is logged in final outcome with httpStatus 504 and is not retried", async () => {
  const infoLogs = [];
  const originalInfo = console.info;
  console.info = (line) => infoLogs.push(line);
  const fake = fakeProvider({
    error: new AIProviderError("timeout", undefined, {
      provider: "gemini",
      httpStatus: 504,
      errorCategory: "timeout",
    }),
  });
  try {
    await assert.rejects(generateInterviewQuestions(input, { providerFactory: fake.providerFactory }), { name: "AIQuestionTimeoutError" });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(infoLogs.length, 1);
  const record = JSON.parse(infoLogs[0]);
  assert.equal(record.outcome, "failure");
  assert.equal(record.errorCategory, "timeout");
  assert.equal(record.httpStatus, 504);
});

test("logs do not contain API keys, prompts, generated content, or credentials", async () => {
  const secretApiKey = "AIzaSyD_SECRET_KEY_999";
  const secretJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload";
  const promptSentinel = "HIGHLY_CONFIDENTIAL_PROMPT_SENTINEL";
  const inputWithSecrets = {
    candidate: { skills: [promptSentinel], experience: 5, targetRole: secretJwt },
    interview: { title: "Secret Interview", category: "Confidential", difficulty: "Intermediate" },
    preferences: { count: 2, difficulty: "Intermediate", category: "Confidential" },
  };
  const errorWithSecret = new AIProviderError("provider_unavailable", undefined, {
    provider: "gemini",
    httpStatus: 500,
    errorCategory: "provider_unavailable",
  });

  const errorLogs = [];
  const infoLogs = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (line) => errorLogs.push(line);
  console.info = (line) => infoLogs.push(line);

  const fake = fakeProvider({ error: errorWithSecret });
  try {
    await assert.rejects(generateInterviewQuestions(inputWithSecrets, { providerFactory: fake.providerFactory }), { name: "AIQuestionProviderError" });
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }

  const combined = `${errorLogs.join("\n")}\n${infoLogs.join("\n")}`;
  assert.equal(combined.includes(secretApiKey), false);
  assert.equal(combined.includes(secretJwt), false);
  assert.equal(combined.includes(promptSentinel), false);
  assert.equal(combined.includes("Secret Interview"), false);
});
