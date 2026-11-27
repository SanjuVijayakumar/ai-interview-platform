const API_URL = "http://localhost:5000/api";
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

class AdminServiceError extends Error {
  constructor(category, message, status) {
    super(message);
    this.name = "AdminServiceError";
    this.category = category;
    if (status !== undefined) this.status = status;
  }
}

function createHttpError(status) {
  const errors = {
    401: ["unauthorized", "Authentication is required to verify administrator access."],
    403: ["forbidden", "Administrator access is required."],
    500: ["server-error", "The administrator service encountered an internal error."],
    503: ["service-unavailable", "The administrator service is temporarily unavailable."],
  };
  const [category, message] = errors[status] || [
    "http-error",
    `The administrator request failed with HTTP status ${status}.`,
  ];

  return new AdminServiceError(category, message, status);
}

function isCancellation(error, signal) {
  return signal?.aborted || error?.name === "AbortError";
}

function createCancellationError() {
  return new AdminServiceError("cancelled", "The administrator identity request was cancelled.");
}

function isValidIdentityResponse(response) {
  const data = response?.data;
  return (
    response?.success === true &&
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof data.userId === "string" &&
    OBJECT_ID_PATTERN.test(data.userId) &&
    data.role === "admin"
  );
}

export async function getAdminIdentity(token, { signal } = {}) {
  if (token === undefined || token === null || token === "") {
    throw new AdminServiceError(
      "missing-token",
      "An authentication token is required to verify administrator access.",
    );
  }

  if (
    typeof token !== "string" ||
    token.trim() !== token ||
    /\s/.test(token)
  ) {
    throw new AdminServiceError("invalid-token", "The authentication token is invalid.");
  }

  if (signal?.aborted) throw createCancellationError();

  let response;
  try {
    response = await fetch(`${API_URL}/admin/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (isCancellation(error, signal)) throw createCancellationError();
    throw new AdminServiceError("network-error", "Could not connect to PrepX. Please try again.");
  }

  if (!response.ok) throw createHttpError(response.status);
  if (response.status !== 200) {
    throw new AdminServiceError(
      "unexpected-status",
      "The administrator identity endpoint returned an unexpected success status.",
      response.status,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (isCancellation(error, signal)) throw createCancellationError();
    throw new AdminServiceError(
      "malformed-response",
      "The administrator identity response was invalid.",
      response.status,
    );
  }

  if (!isValidIdentityResponse(data)) {
    throw new AdminServiceError(
      "malformed-response",
      "The administrator identity response was invalid.",
      response.status,
    );
  }

  return {
    userId: data.data.userId,
    role: data.data.role,
  };
}
