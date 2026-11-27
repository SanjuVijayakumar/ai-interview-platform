import { getAuthToken } from "./authService.js";
import {
  AuthenticatedRequestError,
  authenticatedRequest,
} from "./authenticatedRequest.js";

const API_URL = "http://localhost:5000/api";

async function request(path, options = {}) {
  const token = getAuthToken();
  if (!token) throw new Error("Your session is missing. Please sign in again.");

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
    const error = new Error(data.message || "The mock interview session request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function hasExplicitCapability(options) {
  return (
    options !== null &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    Object.hasOwn(options, "capability")
  );
}

function capabilityRequest(path, capability, options = {}) {
  const forwarded = {};
  if (Object.hasOwn(options, "method")) forwarded.method = options.method;
  if (Object.hasOwn(options, "body")) forwarded.body = options.body;
  if (Object.hasOwn(options, "signal")) forwarded.signal = options.signal;
  if (Object.hasOwn(options, "keepalive")) forwarded.keepalive = options.keepalive;
  if (Object.hasOwn(options, "headers")) forwarded.headers = options.headers;
  return authenticatedRequest(capability, `${API_URL}${path}`, forwarded);
}

function createCapabilityError(error) {
  if (
    error?.status === 409 &&
    error?.data?.errorCode === "session_completed"
  ) {
    const conflict = new Error("Completed sessions cannot be modified");
    conflict.status = 409;
    if (error.category) conflict.category = error.category;
    conflict.data = Object.freeze({ errorCode: "session_completed" });
    return conflict;
  }
  return error;
}

function createInProgressCapabilityError(error) {
  if (
    error?.status === 404 &&
    error?.data?.errorCode === "no_in_progress_session"
  ) {
    const notFound = new AuthenticatedRequestError(
      "http-error",
      404,
      Object.freeze({ errorCode: "no_in_progress_session" }),
    );
    notFound.message = "No in-progress session found";
    return notFound;
  }
  return error;
}

function requireSessionData(data, operation) {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.session === undefined
  ) {
    throw new Error(`The ${operation} response was not in the expected format.`);
  }
  return data.session;
}

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return encodeURIComponent(value.trim());
}

export async function createMockSession(interviewId, options = {}) {
  const id = requireId(interviewId, "Interview ID");
  if (hasExplicitCapability(options)) {
    const result = await capabilityRequest(
      `/interviews/${id}/sessions`,
      options.capability,
      { method: "POST", signal: options.signal },
    );
    return requireSessionData(result.data, "mock interview session creation");
  }
  const data = await request(`/interviews/${id}/sessions`, { method: "POST" });
  return data.session;
}

export async function getMockSession(sessionId, options = {}) {
  const id = requireId(sessionId, "Session ID");
  if (hasExplicitCapability(options)) {
    const result = await capabilityRequest(
      `/mock-sessions/${id}`,
      options.capability,
      { method: "GET", signal: options.signal },
    );
    return requireSessionData(result.data, "mock interview session");
  }
  const data = await request(`/mock-sessions/${id}`);
  return data.session;
}

export async function saveMockSessionAnswer(
  sessionId,
  questionId,
  answerText,
  options = {},
) {
  const keepalive = options?.keepalive === true;
  const session = requireId(sessionId, "Session ID");
  const question = requireId(questionId, "Question ID");
  if (typeof answerText !== "string") throw new Error("Answer text must be a string.");

  if (hasExplicitCapability(options)) {
    try {
      const result = await capabilityRequest(
        `/mock-sessions/${session}/answers/${question}`,
        options.capability,
        {
          method: "PATCH",
          body: JSON.stringify({ answerText }),
          headers: { "Content-Type": "application/json" },
          signal: options.signal,
          keepalive,
        },
      );
      if (
        result.data === null ||
        typeof result.data !== "object" ||
        Array.isArray(result.data)
      ) {
        throw new Error("The answer-save response was not in the expected format.");
      }
      return result.data;
    } catch (error) {
      throw createCapabilityError(error);
    }
  }

  return request(`/mock-sessions/${session}/answers/${question}`, {
    method: "PATCH",
    body: JSON.stringify({ answerText }),
    keepalive,
  });
}

export async function completeMockSession(sessionId, options = {}) {
  const id = requireId(sessionId, "Session ID");
  if (hasExplicitCapability(options)) {
    const result = await capabilityRequest(
      `/mock-sessions/${id}/complete`,
      options.capability,
      { method: "POST", signal: options.signal },
    );
    return requireSessionData(result.data, "mock interview session completion");
  }
  const data = await request(`/mock-sessions/${id}/complete`, { method: "POST" });
  return data.session;
}

export async function findInProgressMockSession(interviewId, options = {}) {
  const id = requireId(interviewId, "Interview ID");
  if (hasExplicitCapability(options)) {
    try {
      const result = await capabilityRequest(
        `/interviews/${id}/sessions/in-progress`,
        options.capability,
        { method: "GET", signal: options.signal },
      );
      return requireSessionData(result.data, "in-progress mock interview session");
    } catch (error) {
      throw createInProgressCapabilityError(error);
    }
  }
  const data = await request(`/interviews/${id}/sessions/in-progress`);
  return data.session;
}
