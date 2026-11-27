import { getAuthToken } from "./authService.js";
import {
  AuthenticatedRequestError,
  authenticatedRequest,
} from "./authenticatedRequest.js";

const API_URL = "http://localhost:5000/api";
const STATS_PATH = "/dashboard/stats";

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

function isValidDashboardStats(stats) {
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  return (
    stats !== null &&
    typeof stats === "object" &&
    validCount(stats.totalInterviews) &&
    validCount(stats.completedInterviews) &&
    validCount(stats.pendingInterviews) &&
    (stats.averageScore === null ||
      (typeof stats.averageScore === "number" &&
        Number.isFinite(stats.averageScore) &&
        stats.averageScore >= 0 &&
        stats.averageScore <= 100))
  );
}

export async function getDashboardStats(options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await authenticatedRequest(
      options.capability,
      `${API_URL}${STATS_PATH}`,
      { method: "GET", signal: options.signal },
    );
    if (!isValidDashboardStats(data)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data;
  }

  const stats = await request(STATS_PATH);
  if (!isValidDashboardStats(stats)) {
    throw new Error("The dashboard statistics response was not in the expected format.");
  }

  return stats;
}
