import { getAuthToken } from "./authService.js";

const API_URL = "http://localhost:5000/api";

async function request(path) {
  const token = getAuthToken();
  if (!token) {
    const error = new Error("Your session is missing. Please sign in again.");
    error.status = 401;
    throw error;
  }

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
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
    const error = new Error(data.message || "The dashboard request could not be completed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export async function getDashboardStats() {
  const stats = await request("/dashboard/stats");
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const validAverage = stats && (
    stats.averageScore === null ||
    (typeof stats.averageScore === "number" &&
      Number.isFinite(stats.averageScore) &&
      stats.averageScore >= 0 &&
      stats.averageScore <= 100)
  );

  if (
    !stats ||
    typeof stats !== "object" ||
    !validCount(stats.totalInterviews) ||
    !validCount(stats.completedInterviews) ||
    !validCount(stats.pendingInterviews) ||
    !validAverage
  ) {
    throw new Error("The dashboard statistics response was not in the expected format.");
  }

  return stats;
}
