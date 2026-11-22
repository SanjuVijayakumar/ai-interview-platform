import { AIProviderError, callerCancelledError as baseCallerCancelledError, invalidProviderOutput, logProviderFailure, normalizeProviderError } from "./normalizeProviderError.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const REFUSAL_FINISH_REASONS = new Set(["content_filter", "safety", "blocked"]);
const INCOMPLETE_FINISH_REASONS = new Set(["length", "max_tokens"]);

function callerCancelledError(options = {}) {
  return baseCallerCancelledError({ provider: "groq", ...options });
}

function inspectResponse(response, model) {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason;
  if ((typeof message?.refusal === "string" && message.refusal.trim()) ||
      REFUSAL_FINISH_REASONS.has(finishReason)) {
    return { text: "", model, provider: "groq", refused: true, incomplete: false };
  }
  if (INCOMPLETE_FINISH_REASONS.has(finishReason)) {
    return { text: "", model, provider: "groq", refused: false, incomplete: true };
  }

  const text = typeof message?.content === "string" ? message.content.trim() : "";
  if (!text) throw invalidProviderOutput("invalid_output");
  try { JSON.parse(text); } catch { throw invalidProviderOutput("invalid_output"); }
  return { text, model, provider: "groq", refused: false, incomplete: false };
}

export async function createAIAdapter({
  apiKey,
  model,
  timeoutMs,
  client: injectedClient,
  clientFactory,
} = {}) {
  if (!apiKey || !model) throw invalidProviderOutput("configuration");
  let client = injectedClient;
  if (!client) {
    try {
      const options = { apiKey, baseURL: GROQ_BASE_URL, timeout: timeoutMs, maxRetries: 0 };
      if (clientFactory) {
        client = clientFactory(options);
      } else {
        const { default: OpenAI } = await import("openai");
        client = new OpenAI(options);
      }
    } catch {
      throw new AIProviderError("provider_unavailable");
    }
  }

  return {
    async generate({
      systemInstruction,
      userPrompt,
      responseSchema,
      maxOutputTokens,
      timeoutMs: requestTimeoutMs,
      signal,
      correlationId,
    } = {}) {
      const requestTimeout = requestTimeoutMs ?? timeoutMs;
      if (signal?.aborted) {
        throw callerCancelledError({ correlationId, attempt: 1, maxAttempts: 1, timeoutMs: requestTimeout, model });
      }

      const requestOptions = {};
      if (requestTimeout) requestOptions.timeout = requestTimeout;
      if (signal) requestOptions.signal = signal;

      let response;
      try {
        response = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "structured_response",
              strict: true,
              schema: responseSchema,
            },
          },
          max_completion_tokens: maxOutputTokens,
        }, Object.keys(requestOptions).length ? requestOptions : undefined);
      } catch (error) {
        if (signal?.aborted) {
          throw callerCancelledError({ correlationId, attempt: 1, maxAttempts: 1, timeoutMs: requestTimeout, model });
        }
        const normalized = normalizeProviderError(error, { timeoutMs: requestTimeout, provider: "groq", model });
        normalized.diagnostics = {
          ...normalized.diagnostics,
          ...(correlationId ? { correlationId } : {}),
          attempt: 1,
          maxAttempts: 1,
          willRetry: false,
        };
        logProviderFailure(normalized.diagnostics);
        throw normalized;
      }

      if (signal?.aborted) {
        throw callerCancelledError({ correlationId, attempt: 1, maxAttempts: 1, timeoutMs: requestTimeout, model });
      }
      return inspectResponse(response, model);
    },
  };
}

export { inspectResponse as inspectGroqResponse };
