const SAFE_MESSAGES = {
  configuration: "AI provider configuration is invalid or unavailable.",
  invalid_request: "The AI provider rejected the request.",
  rate_limited: "The AI service is rate limited. Please try again shortly.",
  quota_exhausted: "The AI provider quota is exhausted.",
  provider_unavailable: "The AI service is temporarily unavailable.",
  timeout: "The AI request timed out.",
  refused: "The AI request could not be completed.",
  incomplete_output: "The AI response was incomplete.",
  invalid_output: "The AI returned an invalid response.",
  caller_cancelled: "The AI request was cancelled.",
};

const SAFE_PROVIDER_CODES = new Set([
  "API_KEY_INVALID", "INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE",
  "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND", "RESOURCE_EXHAUSTED",
  "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED", "CANCELLED", "UNKNOWN",
  "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "MODEL_NOT_FOUND", "SERVICE_DISABLED",
  "BILLING_NOT_ENABLED", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
  "ETIMEDOUT", "EHOSTUNREACH", "ECONNABORTED",
]);
const SAFE_GROQ_ERROR_TYPES = new Set(["invalid_request_error"]);
const SAFE_ERROR_NAMES = new Set([
  "ApiError", "GoogleGenAiError", "APIConnectionTimeoutError", "APIConnectionError",
  "APIUserAbortError", "RequestTimeoutError", "RequestAbortedError", "ConnectionError",
  "TimeoutError", "AbortError", "TypeError", "Error", "AIProviderError",
]);

function httpStatusFrom(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function safeProviderCode(error) {
  const found = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      if (depth < 2) {
        try { visit(JSON.parse(value), depth + 1); } catch { /* Provider message is not JSON. */ }
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (["code", "reason", "status"].includes(normalizedKey) && typeof nested === "string") {
        const candidate = nested.trim().toUpperCase();
        if (SAFE_PROVIDER_CODES.has(candidate)) found.push(candidate);
      }
      if (["code", "reason", "status", "details", "error"].includes(normalizedKey)) visit(nested, depth + 1);
    }
  };
  visit(error?.error);
  visit(error?.body);
  visit(error?.message);
  const systemCode = String(error?.code ?? error?.cause?.code ?? "").trim().toUpperCase();
  if (SAFE_PROVIDER_CODES.has(systemCode)) found.unshift(systemCode);
  return found[0];
}

function safeGroqErrorType(error, provider, suppliedType) {
  if (provider !== "groq") return undefined;
  const type = suppliedType ?? error?.error?.type ?? error?.type;
  return typeof type === "string" && SAFE_GROQ_ERROR_TYPES.has(type) ? type : undefined;
}

function safeDiagnostics(error, { provider, timeoutMs, model, providerErrorType, correlationId, attempt, maxAttempts, willRetry } = {}, errorCategory) {
  const errorName = SAFE_ERROR_NAMES.has(error?.name) ? error.name : "Error";
  const diagnostics = {
    provider: provider === "gemini" || provider === "openai" || provider === "groq" ? provider : "unknown",
    errorName,
    httpStatus: httpStatusFrom(error),
    errorCategory: Object.hasOwn(SAFE_MESSAGES, errorCategory) ? errorCategory : "provider_unavailable",
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000 ? timeoutMs : undefined,
    model: typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,80}$/.test(model) ? model : undefined,
    providerCode: safeProviderCode(error),
    providerErrorType: safeGroqErrorType(error, provider, providerErrorType),
    correlationId: typeof correlationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correlationId) ? correlationId : undefined,
    attempt: Number.isInteger(attempt) && attempt >= 1 && attempt <= 3 ? attempt : undefined,
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3 ? maxAttempts : undefined,
    willRetry: typeof willRetry === "boolean" ? willRetry : undefined,
  };
  return Object.fromEntries(Object.entries(diagnostics).filter(([, value]) => value !== undefined));
}

export function callerCancelledError({ provider = "unknown", correlationId, attempt, maxAttempts, timeoutMs, model } = {}) {
  const safe = safeDiagnostics({ name: "AbortError" }, {
    provider,
    timeoutMs,
    model,
    correlationId,
    attempt,
    maxAttempts,
    willRetry: false,
  }, "caller_cancelled");
  return new AIProviderError("caller_cancelled", undefined, safe);
}

export class AIProviderError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || SAFE_MESSAGES.provider_unavailable, diagnostics) {
    super(message);
    this.name = "AIProviderError";
    this.code = Object.hasOwn(SAFE_MESSAGES, code) ? code : "provider_unavailable";
    if (diagnostics) this.diagnostics = diagnostics;
  }
}

function structuredDetails(error) {
  const strings = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      strings.push(value.toLowerCase());
      if (depth < 2) {
        try { visit(JSON.parse(value), depth + 1); } catch { /* Plain text error message. */ }
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (["message", "status", "reason", "domain", "code", "type", "details", "error"].includes(key.toLowerCase())) {
        visit(nested, depth + 1);
      }
    }
  };
  visit(error?.error);
  visit(error?.body);
  visit(error?.message);
  visit(error?.cause);
  return strings.join(" ");
}

export function normalizeProviderError(error, { timeoutMs, provider, model } = {}) {
  const status = httpStatusFrom(error);
  const details = structuredDetails(error);
  const code = String(error?.code ?? "").toLowerCase();
  let category;

  if (["etimedout", "econnaborted", "timeout"].includes(code) ||
      error?.name === "TimeoutError" || error?.name === "APIConnectionTimeoutError" ||
      (error?.name === "AbortError" && timeoutMs)) {
    category = "timeout";
  } else if (provider === "groq" && status === 400) {
    category = "invalid_request";
  } else if (status === 401 || status === 403 || /api[_ -]?key[_ -]?invalid|invalid api key|unauthenticated|authentication|permission denied/.test(details)) {
    category = "configuration";
  } else if (/model[^\n]*(not found|invalid|unsupported|does not exist)|unsupported model/.test(details) || status === 404) {
    category = "configuration";
  } else if (status === 429) {
    if (/rate.?limit|too many requests|requests per (minute|day)|requests per minute/.test(details)) {
      category = "rate_limited";
    } else if (/quota.{0,30}(exhaust|exceed|limit)|billing|free.?tier|daily limit|monthly limit|resource_exhausted/.test(details)) {
      category = "quota_exhausted";
    } else if (provider === "openai" || provider === "groq") {
      category = "rate_limited";
    } else {
      // Ambiguous 429s may be quota or throttling; do not assume a retry will help.
      category = "provider_unavailable";
    }
  } else if (status === 408 || status === 504) {
    category = "timeout";
  } else {
    category = "provider_unavailable";
  }

  const diagnostics = safeDiagnostics(error, { provider, timeoutMs, model }, category);
  return new AIProviderError(category, undefined, diagnostics);
}

/** Emits only sanitized, allowlisted provider diagnostics; never the SDK message or body. */
export function logProviderFailure(diagnostics) {
  try {
    const safe = safeDiagnostics({ name: diagnostics?.errorName, status: diagnostics?.httpStatus, code: diagnostics?.providerCode }, {
      provider: diagnostics?.provider,
      timeoutMs: diagnostics?.timeoutMs,
      model: diagnostics?.model,
      providerErrorType: diagnostics?.providerErrorType,
      correlationId: diagnostics?.correlationId,
      attempt: diagnostics?.attempt,
      maxAttempts: diagnostics?.maxAttempts,
      willRetry: diagnostics?.willRetry,
    }, Object.hasOwn(SAFE_MESSAGES, diagnostics?.errorCategory) ? diagnostics.errorCategory : "provider_unavailable");
    console.error(JSON.stringify({ event: "ai_provider_request_failed", ...safe }));
  } catch {
    // Diagnostics must never interfere with returning the normalized provider error.
  }
}

/** Logs one safe final outcome for a question-generation request. */
export function logQuestionGenerationOutcome({ correlationId, outcome, errorCategory, httpStatus } = {}) {
  try {
    const safeCorrelationId = typeof correlationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correlationId)
      ? correlationId
      : undefined;
    if (!safeCorrelationId || !["success", "failure", "cancelled"].includes(outcome)) return;
    const safeCategory = Object.hasOwn(SAFE_MESSAGES, errorCategory) ? errorCategory : undefined;
    const safeStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : undefined;
    console.info(JSON.stringify({
      event: "ai_question_generation_completed",
      correlationId: safeCorrelationId,
      outcome,
      ...(outcome !== "success" && safeCategory ? { errorCategory: safeCategory } : {}),
      ...(outcome !== "success" && safeStatus !== undefined ? { httpStatus: safeStatus } : {}),
    }));
  } catch {
    // Diagnostics must never affect question generation.
  }
}

export function invalidProviderOutput(code) {
  return new AIProviderError(code);
}
