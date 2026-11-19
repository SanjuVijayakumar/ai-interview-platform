import { AIProviderError, invalidProviderOutput, logProviderFailure, normalizeProviderError } from "./normalizeProviderError.js";

const SAFETY_FINISH_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);
const QUESTION_RETRY_DELAYS_MS = [2000, 4000];

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function callerCancelledError({ correlationId, attempt, maxAttempts, timeoutMs, model } = {}) {
  return new AIProviderError("caller_cancelled", undefined, {
    provider: "gemini",
    errorName: "AbortError",
    errorCategory: "caller_cancelled",
    timeoutMs,
    model,
    correlationId,
    ...(attempt ? { attempt } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
    willRetry: false,
  });
}

function addAttemptMetadata(error, { correlationId, attempt, maxAttempts, willRetry } = {}) {
  error.diagnostics = {
    ...error.diagnostics,
    ...(correlationId ? { correlationId } : {}),
    attempt,
    maxAttempts,
    willRetry,
  };
  return error;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function inspectResponse(response, model) {
  const blockReason = response?.promptFeedback?.blockReason;
  const candidate = response?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    return { text: "", model, provider: "gemini", refused: true, incomplete: false };
  }
  if (SAFETY_FINISH_REASONS.has(finishReason)) {
    return { text: "", model, provider: "gemini", refused: true, incomplete: false };
  }
  if (finishReason === "MAX_TOKENS" || finishReason === "RECITATION" || finishReason === "LANGUAGE") {
    return { text: "", model, provider: "gemini", refused: false, incomplete: true };
  }

  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!text) throw invalidProviderOutput("invalid_output");
  try { JSON.parse(text); } catch { throw invalidProviderOutput("invalid_output"); }
  return { text, model, provider: "gemini", refused: false, incomplete: false };
}

export async function createAIAdapter({ apiKey, model, timeoutMs, client: injectedClient, sleepFn = waitForRetry } = {}) {
  if (!apiKey || !model) throw invalidProviderOutput("configuration");
  let client = injectedClient;
  if (!client) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      client = new GoogleGenAI({ apiKey });
    } catch {
      throw new AIProviderError("provider_unavailable");
    }
  }

  return {
    async generate({ systemInstruction, userPrompt, responseSchema, maxOutputTokens, timeoutMs: requestTimeoutMs, signal, retry503 = false, correlationId } = {}) {
      const requestTimeout = requestTimeoutMs ?? timeoutMs;
      const deadline = requestTimeout ? Date.now() + requestTimeout : undefined;
      const maxAttempts = retry503 ? 3 : 1;
      let response;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const attemptNumber = attempt + 1;
        if (signal?.aborted) throw callerCancelledError({ correlationId, attempt: attemptNumber, maxAttempts, timeoutMs: requestTimeout, model });
        const remainingTimeout = deadline === undefined ? requestTimeout : Math.max(0, deadline - Date.now());
        if (remainingTimeout === 0) {
          const timeoutError = normalizeProviderError({ name: "TimeoutError", code: "ETIMEDOUT" }, { timeoutMs: requestTimeout, provider: "gemini", model });
          addAttemptMetadata(timeoutError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
          throw timeoutError;
        }
        try {
          response = await client.models.generateContent({
            model,
            contents: userPrompt,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseJsonSchema: responseSchema,
              maxOutputTokens,
              ...(signal ? { abortSignal: signal } : {}),
              ...(requestTimeout ? {
                httpOptions: {
                  timeout: remainingTimeout,
                  ...(retry503 ? { retryOptions: { attempts: 1, httpStatusCodes: [503] } } : {}),
                },
              } : retry503 ? { httpOptions: { retryOptions: { attempts: 1, httpStatusCodes: [503] } } } : {}),
            },
          });
          break;
        } catch (error) {
          if (signal?.aborted) {
            throw callerCancelledError({ correlationId, attempt: attemptNumber, maxAttempts, timeoutMs: requestTimeout, model });
          }
          const normalizedError = normalizeProviderError(error, { timeoutMs: requestTimeout, provider: "gemini", model });
          const canRetry = retry503 && attempt < QUESTION_RETRY_DELAYS_MS.length &&
            normalizedError.diagnostics?.httpStatus === 503 && normalizedError.diagnostics?.providerCode === "UNAVAILABLE";
          if (canRetry) {
            const delayMs = QUESTION_RETRY_DELAYS_MS[attempt];
            const remaining = deadline === undefined ? undefined : deadline - Date.now();
            try {
              await sleepFn(remaining === undefined ? delayMs : Math.min(delayMs, Math.max(0, remaining)), signal);
            } catch (waitError) {
              if (signal?.aborted) {
                addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
                logProviderFailure(normalizedError.diagnostics);
                throw callerCancelledError({ correlationId, attempt: attemptNumber, maxAttempts, timeoutMs: requestTimeout, model });
              }
              addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
              logProviderFailure(normalizedError.diagnostics);
              throw normalizedError;
            }
            if (signal?.aborted) {
              addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
              logProviderFailure(normalizedError.diagnostics);
              throw callerCancelledError({ correlationId, attempt: attemptNumber, maxAttempts, timeoutMs: requestTimeout, model });
            }
            if (deadline !== undefined && Date.now() >= deadline) {
              addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
              logProviderFailure(normalizedError.diagnostics);
              const timeoutError = normalizeProviderError({ name: "TimeoutError", code: "ETIMEDOUT" }, { timeoutMs: requestTimeout, provider: "gemini", model });
              addAttemptMetadata(timeoutError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
              throw timeoutError;
            }
            addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: true });
            logProviderFailure(normalizedError.diagnostics);
            continue;
          }
          addAttemptMetadata(normalizedError, { correlationId, attempt: attemptNumber, maxAttempts, willRetry: false });
          logProviderFailure(normalizedError.diagnostics);
          throw normalizedError;
        }
      }
      return inspectResponse(response, model);
    },
  };
}

export { inspectResponse as inspectGeminiResponse };
