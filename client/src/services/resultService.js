import { getAuthToken } from "./authService.js";

const API_URL = "http://localhost:5000/api";

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

export async function getInterviewResults() {
  const data = await request("/results");
  return Array.isArray(data.results) ? data.results : [];
}

export async function getInterviewResult(resultId) {
  const id = requireId(resultId, "Result ID");
  const data = await request(`/results/${id}`);
  return data.result;
}

export async function getEvaluationStatus(resultId) {
  const id = requireId(resultId, "Result ID");
  return request(`/mock-sessions/${id}/evaluation`);
}

export async function requestEvaluation(resultId, retry) {
  const id = requireId(resultId, "Result ID");
  if (typeof retry !== "boolean") throw new Error("Retry must be an explicit boolean value.");
  return request(`/mock-sessions/${id}/evaluation`, {
    method: "POST",
    body: JSON.stringify({ retry }),
  });
}
