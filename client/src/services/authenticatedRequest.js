const SAFE_CATEGORY_MESSAGES = Object.freeze({
  "missing-capability": "An authenticated request capability is required.",
  "invalid-capability": "The authenticated request capability is invalid.",
  "stale-session": "The authentication session for this request is no longer current.",
  "invalid-destination": "The authenticated request URL is outside the permitted API destination.",
  "invalid-request-options": "The authenticated request options are invalid or unsupported.",
  cancelled: "The authenticated request was cancelled.",
  unauthorized: "The authentication session is no longer valid.",
  forbidden: "Administrator access is no longer authorized.",
  "network-error": "The authenticated request could not reach the API.",
  "http-error": "The authenticated request failed.",
  "malformed-response": "The authenticated response was invalid.",
  "body-read-error": "The authenticated response body could not be read.",
  "request-error": "The authenticated request could not be completed.",
});

export class AuthenticatedRequestError extends Error {
  constructor(category, status, data) {
    super(SAFE_CATEGORY_MESSAGES[category] || SAFE_CATEGORY_MESSAGES["request-error"]);
    this.name = "AuthenticatedRequestError";
    this.category = SAFE_CATEGORY_MESSAGES[category] ? category : "request-error";
    if (Number.isInteger(status)) this.status = status;
    if (data !== undefined) this.data = data;
  }
}

function normalizedCapabilityError(error) {
  if (
    error?.name === "AbortError" ||
    error?.category === "cancelled"
  ) {
    return new AuthenticatedRequestError("cancelled", error?.status);
  }

  const preservedCategories = new Set([
    "stale-session",
    "invalid-destination",
    "invalid-request-options",
    "unauthorized",
    "forbidden",
    "network-error",
  ]);

  if (
    preservedCategories.has(error?.category)
  ) {
    return new AuthenticatedRequestError(error.category, error.status);
  }

  return new AuthenticatedRequestError("request-error");
}

function validateCapability(capability) {
  if (capability === undefined || capability === null) {
    throw new AuthenticatedRequestError("missing-capability");
  }
  if (
    typeof capability !== "object" ||
    typeof capability.fetch !== "function" ||
    typeof capability.isCurrent !== "function"
  ) {
    throw new AuthenticatedRequestError("invalid-capability");
  }
}

function cloneHeaders(headers) {
  if (headers === undefined) return undefined;
  return new Headers(headers);
}

function classifyInProgressSessionNotFound(url, options, status, data) {
  if (status !== 404) return null;
  if (String(options?.method || "GET").toUpperCase() !== "GET") return null;
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.success !== false ||
    data.message !== "No in-progress session found"
  ) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(
      url instanceof URL ? url.href : String(url),
      "http://localhost:5000/",
    );
  } catch {
    return null;
  }

  if (parsedUrl.origin !== "http://localhost:5000") return null;
  return /^\/api\/interviews\/[^/]+\/sessions\/in-progress$/.test(parsedUrl.pathname)
    ? Object.freeze({ errorCode: "no_in_progress_session" })
    : null;
}

function classifyMockSessionConflict(url, options, status, data) {
  if (status !== 409) return null;
  if (String(options?.method || "GET").toUpperCase() !== "PATCH") return null;
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.success !== false ||
    data.message !== "Completed sessions cannot be modified"
  ) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(
      url instanceof URL ? url.href : String(url),
      "http://localhost:5000/",
    );
  } catch {
    return null;
  }

  if (parsedUrl.origin !== "http://localhost:5000") return null;
  return /^\/api\/mock-sessions\/[^/]+\/answers\/[^/]+$/.test(parsedUrl.pathname)
    ? Object.freeze({ errorCode: "session_completed" })
    : null;
}

/**
 * Executes one request through a provider-owned authenticated capability.
 *
 * Success: Promise<{ status: number, data: unknown }>. JSON bodies are parsed
 * as JSON, empty/204/205 bodies return null, and HTTP status is always included.
 *
 * Errors are AuthenticatedRequestError values with a safe category and, where
 * applicable, status. Raw fetch errors and backend response bodies are never
 * included in the error contract.
 */
export async function authenticatedRequest(capability, url, options = {}) {
  validateCapability(capability);

  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new AuthenticatedRequestError("invalid-request-options");
  }

  if (typeof capability.isCurrent !== "function") {
    throw new AuthenticatedRequestError("invalid-capability");
  }

  let current;
  try {
    current = capability.isCurrent();
  } catch {
    throw new AuthenticatedRequestError("invalid-capability");
  }
  if (!current) throw new AuthenticatedRequestError("stale-session");

  if (options.signal?.aborted) {
    throw new AuthenticatedRequestError("cancelled");
  }

  let forwardedOptions;
  try {
    forwardedOptions = { ...options };
    if (options.headers !== undefined) {
      forwardedOptions.headers = cloneHeaders(options.headers);
    }
  } catch {
    throw new AuthenticatedRequestError("invalid-request-options");
  }

  let response;
  try {
    response = await capability.fetch(url, forwardedOptions);
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throw new AuthenticatedRequestError("cancelled");
    }
    throw normalizedCapabilityError(error);
  }

  if (options.signal?.aborted) {
    throw new AuthenticatedRequestError("cancelled");
  }

  if (!isCapabilityCurrent(capability)) {
    throw new AuthenticatedRequestError("stale-session");
  }

  const status = Number.isInteger(response?.status) ? response.status : null;

  if (status === 204 || status === 205) {
    return { status, data: null };
  }

  let bodyText;
  try {
    if (typeof response?.text === "function") {
      bodyText = await response.text();
    } else if (typeof response?.json === "function") {
      throw new AuthenticatedRequestError("body-read-error", status);
    } else {
      throw new AuthenticatedRequestError("body-read-error", status);
    }
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throw new AuthenticatedRequestError("cancelled");
    }
    if (!isCapabilityCurrent(capability)) {
      throw new AuthenticatedRequestError("stale-session");
    }
    if (error instanceof AuthenticatedRequestError) throw error;
    throw new AuthenticatedRequestError("body-read-error", status);
  }

  if (options.signal?.aborted) {
    throw new AuthenticatedRequestError("cancelled");
  }

  if (!isCapabilityCurrent(capability)) {
    throw new AuthenticatedRequestError("stale-session");
  }

  if (typeof bodyText !== "string" || bodyText.length === 0) {
    if (response?.ok) return { status, data: null };
    throw new AuthenticatedRequestError("http-error", status);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (response?.ok) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    throw new AuthenticatedRequestError("http-error", status);
  }

  if (response?.ok) {
    return { status, data };
  }

  const notFoundData = classifyInProgressSessionNotFound(url, forwardedOptions, status, data);
  if (notFoundData) {
    throw new AuthenticatedRequestError("http-error", status, notFoundData);
  }

  const conflictData = classifyMockSessionConflict(url, forwardedOptions, status, data);
  if (conflictData) {
    throw new AuthenticatedRequestError("http-error", status, conflictData);
  }
  throw new AuthenticatedRequestError("http-error", status);
}

function isCapabilityCurrent(capability) {
  try {
    return capability.isCurrent() === true;
  } catch {
    return false;
  }
}
