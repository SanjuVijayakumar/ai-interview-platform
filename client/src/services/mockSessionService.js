import { getAuthToken } from "./authService.js";

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

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return encodeURIComponent(value.trim());
}

export async function createMockSession(interviewId) {
  const id = requireId(interviewId, "Interview ID");
  const data = await request(`/interviews/${id}/sessions`, { method: "POST" });
  return data.session;
}

export async function getMockSession(sessionId) {
  const id = requireId(sessionId, "Session ID");
  const data = await request(`/mock-sessions/${id}`);
  return data.session;
}

export async function saveMockSessionAnswer(sessionId, questionId, answerText, { keepalive = false } = {}) {
  const session = requireId(sessionId, "Session ID");
  const question = requireId(questionId, "Question ID");
  if (typeof answerText !== "string") throw new Error("Answer text must be a string.");

  return request(`/mock-sessions/${session}/answers/${question}`, {
    method: "PATCH",
    body: JSON.stringify({ answerText }),
    keepalive,
  });
}

export async function completeMockSession(sessionId) {
  const id = requireId(sessionId, "Session ID");
  const data = await request(`/mock-sessions/${id}/complete`, { method: "POST" });
  return data.session;
}

export async function findInProgressMockSession(interviewId) {
  const id = requireId(interviewId, "Interview ID");
  const data = await request(`/interviews/${id}/sessions/in-progress`);
  return data.session;
}
