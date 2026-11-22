import assert from "node:assert/strict";
import test from "node:test";
import { AIProviderConfigurationError, DEFAULT_TIMEOUT_MS, getAIProvider, readAIProviderConfiguration } from "../config/aiProvider.js";

const geminiEnv = { GEMINI_API_KEY: "gemini-test-key", GEMINI_MODEL: "gemini-test-model" };
const openAIEnv = { AI_PROVIDER: " OPENAI ", OPENAI_API_KEY: "openai-test-key", OPENAI_MODEL: "openai-test-model" };
const groqEnv = { AI_PROVIDER: " GROQ ", GROQ_API_KEY: "groq-test-key", GROQ_MODEL: "openai/gpt-oss-20b" };

test("Gemini is the default and ignores missing OpenAI configuration", () => {
  assert.deepEqual(readAIProviderConfiguration(geminiEnv), {
    provider: "gemini", apiKey: "gemini-test-key", model: "gemini-test-model", timeoutMs: DEFAULT_TIMEOUT_MS,
  });
});

test("explicit Gemini selection and a configured timeout are accepted", () => {
  assert.equal(readAIProviderConfiguration({ AI_PROVIDER: " Gemini ", ...geminiEnv, AI_REQUEST_TIMEOUT_MS: "1234" }).timeoutMs, 1234);
});

test("explicit OpenAI selection ignores missing Gemini configuration", () => {
  assert.deepEqual(readAIProviderConfiguration(openAIEnv), {
    provider: "openai", apiKey: "openai-test-key", model: "openai-test-model", timeoutMs: DEFAULT_TIMEOUT_MS,
  });
});

test("explicit Groq selection accepts the recommended namespaced model and shared timeout", () => {
  assert.deepEqual(readAIProviderConfiguration({ ...groqEnv, AI_REQUEST_TIMEOUT_MS: "1234" }), {
    provider: "groq", apiKey: "groq-test-key", model: "openai/gpt-oss-20b", timeoutMs: 1234,
  });
});

test("unsupported providers and missing selected-provider configuration fail safely", () => {
  for (const env of [
    { ...geminiEnv, AI_PROVIDER: "other" },
    { GEMINI_MODEL: "gemini-test-model" },
    { GEMINI_API_KEY: "gemini-test-key" },
    { AI_PROVIDER: "openai", OPENAI_MODEL: "openai-test-model" },
    { AI_PROVIDER: "openai", OPENAI_API_KEY: "openai-test-key" },
    { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-20b" },
    { AI_PROVIDER: "groq", GROQ_API_KEY: "groq-test-key" },
    { ...groqEnv, GROQ_MODEL: "invalid model" },
    { ...geminiEnv, AI_REQUEST_TIMEOUT_MS: "-1" },
  ]) {
    assert.throws(() => readAIProviderConfiguration(env), AIProviderConfigurationError);
  }
});

test("configuration errors never include configured secrets", () => {
  const secret = "sensitive-test-key";
  assert.throws(() => readAIProviderConfiguration({ GEMINI_API_KEY: secret }), (error) => {
    assert.equal(error instanceof AIProviderConfigurationError, true);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("provider factory loads only the selected adapter and needs no OpenAI key for Gemini", async () => {
  const loaded = [];
  const provider = await getAIProvider({
    env: geminiEnv,
    adapterLoader: async (name) => {
      loaded.push(name);
      return { createAIAdapter: async (config) => ({ generate: async () => config.model }) };
    },
  });
  assert.deepEqual(loaded, ["gemini"]);
  assert.equal(provider.provider, "gemini");
  assert.equal(provider.model, "gemini-test-model");
  assert.equal(await provider.generate(), "gemini-test-model");
});

test("provider factory loads OpenAI only when explicitly selected", async () => {
  const loaded = [];
  await getAIProvider({
    env: openAIEnv,
    adapterLoader: async (name) => {
      loaded.push(name);
      return { createAIAdapter: async () => ({ generate: async () => null }) };
    },
  });
  assert.deepEqual(loaded, ["openai"]);
});

test("provider factory loads Groq only when explicitly selected", async () => {
  const loaded = [];
  const provider = await getAIProvider({
    env: groqEnv,
    adapterLoader: async (name) => {
      loaded.push(name);
      return { createAIAdapter: async (config) => ({ generate: async () => config.model }) };
    },
  });
  assert.deepEqual(loaded, ["groq"]);
  assert.equal(provider.provider, "groq");
  assert.equal(provider.model, "openai/gpt-oss-20b");
  assert.equal(await provider.generate(), "openai/gpt-oss-20b");
});

test("the selected Groq adapter is available without making a provider request", async () => {
  const provider = await getAIProvider({ env: groqEnv });
  assert.equal(provider.provider, "groq");
  assert.equal(provider.model, "openai/gpt-oss-20b");
  assert.equal(typeof provider.generate, "function");
});
