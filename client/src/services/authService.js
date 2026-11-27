const API_BASE_URL = "http://localhost:5000/api/auth";
const TOKEN_STORAGE_KEY = "token";
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

class AuthServiceError extends Error {
  constructor(category, message, status) {
    super(message);
    this.name = "AuthServiceError";
    this.category = category;
    if (status !== undefined) this.status = status;
  }
}

function createHttpError(status) {
  const errors = {
    401: ["unauthorized", "Authentication is required to verify the current session."],
    403: ["forbidden", "Access to the current session was denied."],
    500: ["server-error", "The authentication service encountered an internal error."],
    503: ["service-unavailable", "The authentication service is temporarily unavailable."],
  };
  const [category, message] = errors[status] || [
    "http-error",
    `The session identity request failed with HTTP status ${status}.`,
  ];

  return new AuthServiceError(category, message, status);
}

function isCancellation(error, signal) {
  return signal?.aborted || error?.name === "AbortError";
}

function createCancellationError() {
  return new AuthServiceError("cancelled", "The session identity request was cancelled.");
}

function isValidSessionIdentityResponse(response) {
  const user = response?.user;
  return (
    response?.success === true &&
    user !== null &&
    typeof user === "object" &&
    !Array.isArray(user) &&
    typeof user.id === "string" &&
    OBJECT_ID_PATTERN.test(user.id) &&
    typeof user.name === "string" &&
    Boolean(user.name.trim()) &&
    typeof user.email === "string" &&
    Boolean(user.email.trim()) &&
    (user.role === "user" || user.role === "admin")
  );
}

export async function loginUser({ email, password }) {
  let response;

  try {
    response = await fetch(`${API_BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error("Could not connect to PrepX. Check that the backend is running and try again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "Login failed. Please check your details and try again.");
  }

  if (!data.token) {
    throw new Error("Login succeeded, but the server did not return an authentication token.");
  }

  window.localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
  return data;
}

export async function exchangeLoginCredentials({ email, password }, { signal } = {}) {
  const cancelled = () => new AuthServiceError("cancelled", "The login request was cancelled.");
  if (signal?.aborted) throw cancelled();

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled();
    throw new AuthServiceError("network-error", "Could not connect to PrepX. Please try again.");
  }

  if (signal?.aborted) throw cancelled();
  if (response.status === 401) {
    throw new AuthServiceError("invalid-credentials", "Invalid email or password.", 401);
  }
  if (!response.ok) {
    throw new AuthServiceError("http-error", "The login request failed.", response.status);
  }
  const malformed = () => new AuthServiceError("malformed-response", "The login response was invalid.", response.status);
  if (response.status !== 200) throw malformed();

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled();
    throw malformed();
  }

  if (signal?.aborted) throw cancelled();
  if (!isValidSessionIdentityResponse(data) || !isValidToken(data.token)) throw malformed();
  return { token: data.token };
}

function isValidToken(token) {
  return typeof token === "string" && token.length > 0 && !/\s/.test(token);
}

export async function getSessionIdentity(token, { signal } = {}) {
  if (token === undefined || token === null || token === "") {
    throw new AuthServiceError(
      "missing-token",
      "An authentication token is required to verify the current session.",
    );
  }

  if (!isValidToken(token)) {
    throw new AuthServiceError("invalid-token", "The authentication token is invalid.");
  }

  if (signal?.aborted) throw createCancellationError();

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (isCancellation(error, signal)) throw createCancellationError();
    throw new AuthServiceError(
      "network-error",
      "Could not connect to PrepX. Please try again.",
    );
  }

  if (signal?.aborted) throw createCancellationError();
  if (!response.ok) throw createHttpError(response.status);
  if (response.status !== 200) {
    throw new AuthServiceError(
      "unexpected-status",
      "The session identity endpoint returned an unexpected success status.",
      response.status,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (isCancellation(error, signal)) throw createCancellationError();
    throw new AuthServiceError(
      "malformed-response",
      "The session identity response was invalid.",
      response.status,
    );
  }

  if (isCancellation(null, signal)) throw createCancellationError();
  if (!isValidSessionIdentityResponse(data)) {
    throw new AuthServiceError(
      "malformed-response",
      "The session identity response was invalid.",
      response.status,
    );
  }

  return {
    id: data.user.id,
    name: data.user.name,
    email: data.user.email,
    role: data.user.role,
  };
}

export function getAuthToken() {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function logoutUser() {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event("prepx:logout"));
}
