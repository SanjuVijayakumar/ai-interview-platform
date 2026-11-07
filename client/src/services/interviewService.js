import { getAuthToken } from "./authService.js";

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

export async function getInterviews() {
  const data = await request();
  if (!Array.isArray(data.interviews)) throw new Error("The interviews response was not in the expected format.");
  return data.interviews;
}

export async function createInterview(interview) {
  const data = await request("", { method: "POST", body: JSON.stringify(interview) });
  return data.interview;
}

export async function updateInterview(id, updates) {
  const data = await request(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(updates) });
  return data.interview;
}

export async function deleteInterview(id) {
  const data = await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
  return data.interview;
}
