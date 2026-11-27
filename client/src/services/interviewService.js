import { getAuthToken } from "./authService.js";
import {
  AuthenticatedRequestError,
  authenticatedRequest,
} from "./authenticatedRequest.js";

const API_URL = "http://localhost:5000/api/interviews";

async function request(path = "", options = {}) {
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

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "The interview request could not be completed.");
  return data;
}

function hasInterviewIdentity(interview) {
  return interview !== null &&
    typeof interview === "object" &&
    !Array.isArray(interview) &&
    typeof interview._id === "string" &&
    interview._id.trim().length > 0;
}

function interviewDetailUrl(interviewId) {
  // Keep the ID in one path segment. The backend still validates ObjectIds.
  if (typeof interviewId !== "string" || !interviewId || /[^A-Za-z0-9_-]/.test(interviewId)) {
    throw new AuthenticatedRequestError("invalid-destination");
  }
  return `${API_URL}/${interviewId}`;
}

export async function getInterviews(options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await authenticatedRequest(
      options.capability,
      API_URL,
      { method: "GET", signal: options.signal },
    );
    if (data?.success !== true || !Array.isArray(data.interviews) ||
        !data.interviews.every(hasInterviewIdentity)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data.interviews;
  }

  const data = await request();
  if (!Array.isArray(data.interviews)) throw new Error("The interviews response was not in the expected format.");
  return data.interviews;
}

export async function getInterviewById(interviewId, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await authenticatedRequest(
      options.capability,
      interviewDetailUrl(interviewId),
      { method: "GET", signal: options.signal },
    );
    if (data?.success !== true || !hasInterviewIdentity(data.interview)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data.interview;
  }

  const data = await request(`/${encodeURIComponent(interviewId)}`);
  return data.interview;
}

async function requestMutation(url, { capability, signal }, requestOptions) {
  const { data, status } = await authenticatedRequest(capability, url, {
    ...requestOptions,
    signal,
    ...(requestOptions.body ? { headers: { "Content-Type": "application/json" } } : {}),
  });
  if (data?.success !== true || !hasInterviewIdentity(data.interview)) {
    throw new AuthenticatedRequestError("malformed-response", status);
  }
  return data.interview;
}

export async function createInterview(interview, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    return requestMutation(API_URL, options, { method: "POST", body: JSON.stringify(interview) });
  }
  const data = await request("", { method: "POST", body: JSON.stringify(interview) });
  return data.interview;
}

export async function updateInterview(id, updates, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    return requestMutation(interviewDetailUrl(id), options, { method: "PATCH", body: JSON.stringify(updates) });
  }
  const data = await request(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(updates) });
  return data.interview;
}

export async function deleteInterview(id, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    return requestMutation(interviewDetailUrl(id), options, { method: "DELETE" });
  }
  const data = await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
  return data.interview;
}
