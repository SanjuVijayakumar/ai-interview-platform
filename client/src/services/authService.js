const API_BASE_URL = "http://localhost:5000/api/auth";
const TOKEN_STORAGE_KEY = "token";

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

export function getAuthToken() {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function logoutUser() {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}
