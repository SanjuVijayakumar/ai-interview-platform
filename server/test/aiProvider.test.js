import assert from "node:assert/strict";
import test from "node:test";
import { AIProviderConfigurationError, DEFAULT_TIMEOUT_MS, getAIProvider, readAIProviderConfiguration } from "../config/aiProvider.js";

const geminiEnv = { GEMINI_API_KEY: "gemini-test-key", GEMINI_MODEL: "gemini-test-model" };
const openAIEnv = { AI_PROVIDER: " OPENAI ", OPENAI_API_KEY: "openai-test-key", OPENAI_MODEL: "openai-test-model" };

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

test("unsupported providers and missing selected-provider configuration fail safely", () => {
  for (const env of [
    { ...geminiEnv, AI_PROVIDER: "other" },
    { GEMINI_MODEL: "gemini-test-model" },
    { GEMINI_API_KEY: "gemini-test-key" },
    { AI_PROVIDER: "openai", OPENAI_MODEL: "openai-test-model" },
    { AI_PROVIDER: "openai", OPENAI_API_KEY: "openai-test-key" },
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
