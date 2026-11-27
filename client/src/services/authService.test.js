import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeLoginCredentials, getAuthToken, getSessionIdentity, loginUser, logoutUser } from "./authService.js";

const TOKEN = "synthetic-explicit-session-token";
const USER_ID = "507f1f77bcf86cd799439011";
const USER = {
  id: USER_ID,
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "user",
  skills: ["React"],
  experience: 5,
  targetRole: "Engineer",
  password: "unexpected-password-value",
  extra: "unexpected response field",
};
const PROFILE_RESPONSE = {
  success: true,
  message: "Profile retrieved successfully",
  user: USER,
  extra: "unexpected response field",
};

function jsonResponse(data, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => data };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectSafeError(promise, category, status) {
  return expect(promise).rejects.toMatchObject({
    category,
    ...(status === undefined ? {} : { status }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("exchangeLoginCredentials", () => {
  const credentials = { email: "synthetic@example.test", password: "synthetic-password" };
  const result = { success: true, token: TOKEN, user: USER };

  it("sends the exact login request and returns the token without writing storage", async () => {
    window.localStorage.setItem("token", "previous-synthetic-token");
    const { signal } = new AbortController();
    fetch.mockResolvedValue(jsonResponse(result));
    await expect(exchangeLoginCredentials(credentials, { signal })).resolves.toEqual({ token: TOKEN });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:5000/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials), signal, redirect: "error",
    });
    expect(getAuthToken()).toBe("previous-synthetic-token");
  });

  it.each([
    { token: undefined }, { token: "" }, { token: "a b" }, { token: 42 },
    { success: false }, { user: null }, { user: { ...USER, id: "bad" } },
  ])("rejects malformed success %#", async (change) => {
    fetch.mockResolvedValue(jsonResponse({ ...result, ...change }));
    await expectSafeError(exchangeLoginCredentials(credentials), "malformed-response", 200);
    expect(getAuthToken()).toBeNull();
  });

  it.each([401, 500, 201])("uses safe structured errors for HTTP %s", async (status) => {
    const json = vi.fn().mockResolvedValue({ ...result, message: "private response" });
    fetch.mockResolvedValue({ ok: status < 300, status, json });
    const error = await exchangeLoginCredentials(credentials).catch((error) => error);
    expect(error).toMatchObject({
      category: { 401: "invalid-credentials", 500: "http-error", 201: "malformed-response" }[status], status,
    });
    expect(error.message).not.toContain("private");
    expect(json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes a transport failure without forwarding details or retrying", async () => {
    fetch.mockRejectedValue(new Error("private transport details"));
    await expectSafeError(exchangeLoginCredentials(credentials), "network-error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles a simulated redirect rejection without retrying or persisting credentials", async () => {
    fetch.mockRejectedValueOnce(new TypeError(`Redirect rejected for ${credentials.password}`));
    await expect(exchangeLoginCredentials(credentials)).rejects.toMatchObject({
      name: "AuthServiceError",
      category: "network-error",
      message: "Could not connect to PrepX. Please try again.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBeNull();
  });

  it.each(["before transport", "during transport", "during parsing"])("honors cancellation %s", async (phase) => {
    const controller = new AbortController();
    const pending = deferred();
    const json = vi.fn().mockReturnValue(pending.promise);
    if (phase === "before transport") controller.abort();
    fetch.mockReturnValue(phase === "during transport" ? pending.promise : Promise.resolve({
      ok: true, status: 200, json,
    }));
    const request = exchangeLoginCredentials(credentials, { signal: controller.signal });
    const assertion = expectSafeError(request, "cancelled");
    if (phase === "during parsing") {
      await Promise.resolve();
      expect(json).toHaveBeenCalledOnce();
    }
    controller.abort();
    pending.resolve(phase === "during parsing" ? result : { ok: true, status: 200, json });
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(phase === "before transport" ? 0 : 1);
    expect(getAuthToken()).toBeNull();
  });
});

describe("getSessionIdentity", () => {
  it("returns a normalized identity for a regular user", async () => {
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    await expect(getSessionIdentity(TOKEN)).resolves.toEqual({
      id: USER_ID,
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "user",
    });
  });

  it("returns the backend-reported administrator role without granting admin authorization", async () => {
    fetch.mockResolvedValue(jsonResponse({
      ...PROFILE_RESPONSE,
      user: { ...USER, role: "admin" },
    }));

    await expect(getSessionIdentity(TOKEN)).resolves.toEqual({
      id: USER_ID,
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "admin",
    });
  });

  it("uses GET for the profile identity endpoint", async () => {
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    await getSessionIdentity(TOKEN);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/api/auth/profile",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("sends the explicitly supplied token as a Bearer credential", async () => {
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    await getSessionIdentity(TOKEN);

    expect(fetch.mock.calls[0][1].headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("handles a simulated profile redirect rejection without retry or token fallback", async () => {
    window.localStorage.setItem("token", "synthetic-other-token");
    fetch.mockRejectedValueOnce(new TypeError(`Redirect rejected for ${TOKEN}`));
    await expect(getSessionIdentity(TOKEN)).rejects.toMatchObject({
      name: "AuthServiceError",
      category: "network-error",
      message: "Could not connect to PrepX. Please try again.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBe("synthetic-other-token");
  });

  it("uses the supplied token rather than a different token in localStorage", async () => {
    window.localStorage.setItem("token", "synthetic-stored-token");
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    await getSessionIdentity(TOKEN);

    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([undefined, null, ""])("rejects a missing token (%s) before requesting", async (token) => {
    await expectSafeError(getSessionIdentity(token), "missing-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([123, " token ", "token with spaces", "  "])(
    "rejects invalid token input (%s) before requesting",
    async (token) => {
      await expectSafeError(getSessionIdentity(token), "invalid-token");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "server-error"],
    [503, "service-unavailable"],
  ])("preserves safe error category and status for HTTP %i", async (status, category) => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: `Sensitive backend detail with ${TOKEN}` },
      { status, ok: false },
    ));

    await expectSafeError(getSessionIdentity(TOKEN), category, status);
  });

  it("categorizes other unsuccessful HTTP statuses", async () => {
    fetch.mockResolvedValue(jsonResponse({}, { status: 404, ok: false }));

    await expectSafeError(getSessionIdentity(TOKEN), "http-error", 404);
  });

  it("rejects unexpected successful HTTP statuses", async () => {
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE, { status: 201 }));

    await expectSafeError(getSessionIdentity(TOKEN), "unexpected-status", 201);
  });

  it("reports network failures without exposing the underlying error", async () => {
    fetch.mockRejectedValue(new Error(`Failed to send ${TOKEN}`));

    let thrownError;
    try {
      await getSessionIdentity(TOKEN);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toMatchObject({ category: "network-error" });
    expect(thrownError.message).not.toContain(TOKEN);
    expect(thrownError).not.toHaveProperty("cause");
    expect(thrownError).not.toHaveProperty("request");
  });

  it("rejects a response that cannot be parsed as JSON", async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("invalid JSON"); },
    });

    await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
  });

  it.each([null, {}, { success: true }, { success: true, user: null }, { success: true, user: [] }])(
    "rejects a missing or malformed user object",
    async (body) => {
      fetch.mockResolvedValue(jsonResponse(body));

      await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
    },
  );

  it("rejects success false in an HTTP 200 response", async () => {
    fetch.mockResolvedValue(jsonResponse({ ...PROFILE_RESPONSE, success: false }));

    await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
  });

  it.each(["not-an-object-id", "507f1f77bcf86cd79943901", "507f1f77bcf86cd79943901g"])(
    "rejects an invalid MongoDB ObjectId (%s)",
    async (id) => {
      fetch.mockResolvedValue(jsonResponse({
        ...PROFILE_RESPONSE,
        user: { ...USER, id },
      }));

      await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
    },
  );

  it.each([undefined, null, "", "   ", 42])("rejects an invalid name (%s)", async (name) => {
    fetch.mockResolvedValue(jsonResponse({
      ...PROFILE_RESPONSE,
      user: { ...USER, name },
    }));

    await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
  });

  it.each([undefined, null, "", "   ", 42])("rejects an invalid email (%s)", async (email) => {
    fetch.mockResolvedValue(jsonResponse({
      ...PROFILE_RESPONSE,
      user: { ...USER, email },
    }));

    await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
  });

  it("accepts a non-empty email string without imposing extra format validation", async () => {
    fetch.mockResolvedValue(jsonResponse({
      ...PROFILE_RESPONSE,
      user: { ...USER, email: "existing-backend-value" },
    }));

    await expect(getSessionIdentity(TOKEN)).resolves.toMatchObject({
      email: "existing-backend-value",
    });
  });

  it.each([undefined, null, "", "superuser"])("rejects an unsupported role (%s)", async (role) => {
    fetch.mockResolvedValue(jsonResponse({
      ...PROFILE_RESPONSE,
      user: { ...USER, role },
    }));

    await expectSafeError(getSessionIdentity(TOKEN), "malformed-response", 200);
  });

  it("excludes unexpected response and profile fields from the normalized identity", async () => {
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    await expect(getSessionIdentity(TOKEN)).resolves.toEqual({
      id: USER_ID,
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "user",
    });
  });

  it("passes the AbortSignal to fetch and reports an in-flight cancellation", async () => {
    const controller = new AbortController();
    fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Request aborted", "AbortError")),
        { once: true },
      );
    }));

    const request = getSessionIdentity(TOKEN, { signal: controller.signal });
    controller.abort();

    await expectSafeError(request, "cancelled");
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("does not make a request for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectSafeError(
      getSessionIdentity(TOKEN, { signal: controller.signal }),
      "cancelled",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports cancellation when the request is aborted during response parsing", async () => {
    const controller = new AbortController();
    const body = deferred();
    const response = {
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    };
    fetch.mockResolvedValue(response);

    const request = getSessionIdentity(TOKEN, { signal: controller.signal });
    await Promise.resolve();
    expect(response.json).toHaveBeenCalledOnce();

    controller.abort();
    body.resolve(PROFILE_RESPONSE);

    await expectSafeError(request, "cancelled");
  });

  it("does not expose tokens or backend details in errors", async () => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: `Internal failure involving ${TOKEN}` },
      { status: 500, ok: false },
    ));

    let thrownError;
    try {
      await getSessionIdentity(TOKEN);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.category).toBe("server-error");
    expect(thrownError.message).not.toContain(TOKEN);
    expect(thrownError.message).not.toContain("Internal failure");
    expect(thrownError).not.toHaveProperty("data");
    expect(thrownError).not.toHaveProperty("request");
  });

  it("does not mutate localStorage or dispatch logout events", async () => {
    window.localStorage.setItem("token", "synthetic-stored-token");
    window.localStorage.setItem("role", "user");
    const before = {
      token: window.localStorage.getItem("token"),
      role: window.localStorage.getItem("role"),
    };
    const logoutListener = vi.fn();
    window.addEventListener("prepx:logout", logoutListener);
    fetch.mockResolvedValue(jsonResponse(PROFILE_RESPONSE));

    try {
      await getSessionIdentity(TOKEN);
    } finally {
      window.removeEventListener("prepx:logout", logoutListener);
    }

    expect(window.localStorage.getItem("token")).toBe(before.token);
    expect(window.localStorage.getItem("role")).toBe(before.role);
    expect(logoutListener).not.toHaveBeenCalled();
  });
});

describe("existing authService behavior", () => {
  it("preserves login token storage, token retrieval, and logout event behavior", async () => {
    fetch.mockResolvedValue(jsonResponse({
      success: true,
      token: "synthetic-login-response-token",
      user: { id: USER_ID, name: "Ada Lovelace", email: "ada@example.com", role: "user" },
    }));
    const logoutListener = vi.fn();
    window.addEventListener("prepx:logout", logoutListener);

    try {
      await loginUser({ email: "ada@example.com", password: "synthetic-password" });
      expect(getAuthToken()).toBe("synthetic-login-response-token");
      expect(fetch.mock.calls[0][1]).not.toHaveProperty("redirect");

      logoutUser();

      expect(getAuthToken()).toBeNull();
      expect(logoutListener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("prepx:logout", logoutListener);
    }
  });
});
