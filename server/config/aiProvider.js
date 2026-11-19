const DEFAULT_TIMEOUT_MS = 60000;

export class AIProviderConfigurationError extends Error {
  constructor(message = "AI provider configuration is invalid or unavailable.") {
    super(message);
    this.name = "AIProviderConfigurationError";
    this.code = "configuration";
  }
}

export function readAIProviderConfiguration(env = process.env) {
  const provider = String(env.AI_PROVIDER ?? "gemini").trim().toLowerCase();
  if (provider !== "gemini" && provider !== "openai") {
    throw new AIProviderConfigurationError("AI_PROVIDER must be gemini or openai.");
  }

  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const modelName = provider === "gemini" ? "GEMINI_MODEL" : "OPENAI_MODEL";
  const apiKey = typeof env[keyName] === "string" ? env[keyName].trim() : "";
  const model = typeof env[modelName] === "string" ? env[modelName].trim() : "";
  if (!apiKey) throw new AIProviderConfigurationError(`${keyName} is required for the selected AI provider.`);
  if (!model || /\s/.test(model)) throw new AIProviderConfigurationError(`${modelName} is invalid for the selected AI provider.`);

  const configuredTimeout = env.AI_REQUEST_TIMEOUT_MS;
  const timeoutMs = configuredTimeout === undefined || configuredTimeout === ""
    ? DEFAULT_TIMEOUT_MS
    : Number(configuredTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new AIProviderConfigurationError("AI_REQUEST_TIMEOUT_MS must be an integer from 1 to 300000.");
  }

  return { provider, apiKey, model, timeoutMs };
}

/** Loads only the selected SDK adapter; configuration is read at call time. */
export async function getAIProvider({ env = process.env, adapterLoader } = {}) {
  const configuration = readAIProviderConfiguration(env);
  let adapterModule;
  if (adapterLoader) {
    adapterModule = await adapterLoader(configuration.provider);
  } else if (configuration.provider === "gemini") {
    adapterModule = await import("../services/aiProviders/geminiAdapter.js");
  } else {
    adapterModule = await import("../services/aiProviders/openaiAdapter.js");
  }
  const adapter = await adapterModule.createAIAdapter(configuration);
  return { ...adapter, provider: configuration.provider, model: configuration.model, timeoutMs: configuration.timeoutMs };
}

export { DEFAULT_TIMEOUT_MS };
