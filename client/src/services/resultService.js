import { getAuthToken } from "./authService.js";
import { AuthenticatedRequestError, authenticatedRequest } from "./authenticatedRequest.js";

const API_URL = "http://localhost:5000/api";
const evaluationStates = new Set(["not-requested", "pending", "completed", "failed"]);

async function request(path, options = {}) {
  const token = getAuthToken();
  if (!token) {
    const error = new Error("Your session is missing. Please sign in again.");
    error.status = 401;
    throw error;
  }

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Could not connect to PrepX. Check that the backend is running and try again.");
  }

  const responseText = await response.text().catch(() => "");
  let data = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { message: responseText };
    }
  }
  if (!response.ok) {
    const error = new Error(data.message || "The result request could not be completed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return encodeURIComponent(value.trim());
}

function safePathSegment(id) {
  if (typeof id !== "string" || !id || /[^A-Za-z0-9_-]/.test(id)) {
    throw new AuthenticatedRequestError("invalid-destination");
  }
  return id;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResult(value) {
  return isRecord(value) && typeof value._id === "string" && value._id.trim() !== "" &&
    (value.status === "in-progress" || value.status === "completed") &&
    Array.isArray(value.answers) && value.answers.every(isRecord) &&
    (value.overallScore == null || Number.isFinite(value.overallScore));
}

function isEvaluationStatus(value) {
  return evaluationStates.has(value.status) &&
    Number.isInteger(value.attemptCount) && value.attemptCount >= 0 &&
    (value.status !== "failed" || typeof value.retryAvailable === "boolean") &&
    (value.status !== "completed" || (isResult(value.evaluation) && value.evaluation.status === "completed"));
}

async function requestWithCapability(path, { capability, signal }, requestOptions = {}) {
  const { data, status } = await authenticatedRequest(capability, API_URL + path, {
    method: "GET",
    ...requestOptions,
    signal,
  });
  if (data?.success !== true) throw new AuthenticatedRequestError("malformed-response", status);
  return { data, status };
}

export async function getInterviewResults(options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await requestWithCapability("/results", options);
    if (!Array.isArray(data.results) || !data.results.every(isResult)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data.results;
  }
  const data = await request("/results");
  return Array.isArray(data.results) ? data.results : [];
}

export async function getInterviewResult(resultId, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await requestWithCapability(`/results/${safePathSegment(resultId)}`, options);
    if (!isResult(data.result)) throw new AuthenticatedRequestError("malformed-response", status);
    return data.result;
  }
  const id = requireId(resultId, "Result ID");
  const data = await request(`/results/${id}`);
  return data.result;
}

export async function getEvaluationStatus(resultId, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await requestWithCapability(`/mock-sessions/${safePathSegment(resultId)}/evaluation`, options);
    if (!isEvaluationStatus(data)) throw new AuthenticatedRequestError("malformed-response", status);
    return data;
  }
  const id = requireId(resultId, "Result ID");
  return request(`/mock-sessions/${id}/evaluation`);
}

export async function requestEvaluation(resultId, retry, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const id = safePathSegment(resultId);
    if (typeof retry !== "boolean") throw new AuthenticatedRequestError("invalid-request-options");
    const { data, status } = await requestWithCapability(`/mock-sessions/${id}/evaluation`, options, {
      method: "POST",
      body: JSON.stringify({ retry }),
      headers: { "Content-Type": "application/json" },
    });
    const expectedState = { 200: "completed", 202: "pending" }[status];
    if (!expectedState || data.status !== expectedState || !isEvaluationStatus(data)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data;
  }
  const id = requireId(resultId, "Result ID");
  if (typeof retry !== "boolean") throw new Error("Retry must be an explicit boolean value.");
  return request(`/mock-sessions/${id}/evaluation`, {
    method: "POST",
    body: JSON.stringify({ retry }),
  });
}
