import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminIdentity } from "./adminService.js";

const TOKEN = "synthetic-admin-token";
const IDENTITY = {
  success: true,
  data: {
    userId: "507f1f77bcf86cd799439011",
    role: "admin",
  },
};

function jsonResponse(data, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => data };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("adminService", () => {
  it("returns only the verified administrator identity", async () => {
    fetch.mockResolvedValue(jsonResponse(IDENTITY));

    await expect(getAdminIdentity(TOKEN)).resolves.toEqual({
      userId: IDENTITY.data.userId,
      role: "admin",
    });
  });

  it("uses GET for the administrator identity endpoint", async () => {
    fetch.mockResolvedValue(jsonResponse(IDENTITY));

    await getAdminIdentity(TOKEN);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/api/admin/me",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("sends the explicitly supplied token as a Bearer credential", async () => {
    fetch.mockResolvedValue(jsonResponse(IDENTITY));

    await getAdminIdentity(TOKEN);

    expect(fetch.mock.calls[0][1].headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it.each([undefined, null, ""])("rejects a missing token (%s) before requesting", async (token) => {
    await expect(getAdminIdentity(token)).rejects.toMatchObject({
      category: "missing-token",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([123, " token ", "token with spaces"])("rejects invalid token input (%s)", async (token) => {
    await expect(getAdminIdentity(token)).rejects.toMatchObject({
      category: "invalid-token",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "server-error"],
    [503, "service-unavailable"],
  ])("preserves the error category and status for HTTP %i", async (status, category) => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: "Backend detail that must not be used." },
      { status, ok: false },
    ));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({ category, status });
  });

  it("categorizes other unsuccessful HTTP statuses", async () => {
    fetch.mockResolvedValue(jsonResponse({}, { status: 404, ok: false }));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "http-error",
      status: 404,
    });
  });

  it("rejects unexpected successful HTTP statuses", async () => {
    fetch.mockResolvedValue(jsonResponse(IDENTITY, { status: 201 }));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "unexpected-status",
      status: 201,
    });
  });

  it("reports network failures without exposing the underlying error", async () => {
    fetch.mockRejectedValue(new Error(`Failed to send ${TOKEN}`));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "network-error",
      message: "Could not connect to PrepX. Please try again.",
    });
  });

  it("handles a simulated administrator redirect rejection without retry or token fallback", async () => {
    window.localStorage.setItem("token", "synthetic-other-token");
    fetch.mockRejectedValueOnce(new TypeError(`Redirect rejected for ${TOKEN}`));
    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      name: "AdminServiceError",
      category: "network-error",
      message: "Could not connect to PrepX. Please try again.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("token")).toBe("synthetic-other-token");
  });

  it("rejects a response that cannot be parsed as JSON", async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("invalid JSON"); },
    });

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "malformed-response",
      status: 200,
    });
  });

  it.each([
    null,
    {},
    { success: true },
    { success: true, data: null },
    { success: true, data: [] },
  ])("rejects missing or malformed response data", async (body) => {
    fetch.mockResolvedValue(jsonResponse(body));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "malformed-response",
    });
  });

  it("rejects success false in an HTTP 200 response", async () => {
    fetch.mockResolvedValue(jsonResponse({ ...IDENTITY, success: false }));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "malformed-response",
    });
  });

  it("rejects a response whose role is not admin", async () => {
    fetch.mockResolvedValue(jsonResponse({
      ...IDENTITY,
      data: { ...IDENTITY.data, role: "user" },
    }));

    await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
      category: "malformed-response",
    });
  });

  it.each(["not-an-object-id", "507f1f77bcf86cd79943901", "507f1f77bcf86cd79943901g"])(
    "rejects an invalid MongoDB ObjectId (%s)",
    async (userId) => {
      fetch.mockResolvedValue(jsonResponse({
        ...IDENTITY,
        data: { ...IDENTITY.data, userId },
      }));

      await expect(getAdminIdentity(TOKEN)).rejects.toMatchObject({
        category: "malformed-response",
      });
    },
  );

  it("excludes additional server fields from the normalized identity", async () => {
    fetch.mockResolvedValue(jsonResponse({
      ...IDENTITY,
      data: { ...IDENTITY.data, email: "private@example.test", extra: "ignored" },
      extra: "ignored",
    }));

    await expect(getAdminIdentity(TOKEN)).resolves.toEqual({
      userId: IDENTITY.data.userId,
      role: "admin",
    });
  });

  it("passes the AbortSignal to fetch and categorizes cancellation", async () => {
    const controller = new AbortController();
    fetch.mockRejectedValue(new DOMException("Request aborted", "AbortError"));

    await expect(getAdminIdentity(TOKEN, { signal: controller.signal })).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("does not make a request for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(getAdminIdentity(TOKEN, { signal: controller.signal })).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose the token or backend details in errors", async () => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: `Internal failure involving ${TOKEN}` },
      { status: 500, ok: false },
    ));

    let thrownError;
    try {
      await getAdminIdentity(TOKEN);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.category).toBe("server-error");
    expect(thrownError.message).not.toContain(TOKEN);
    expect(thrownError.message).not.toContain("Internal failure");
    expect(thrownError).not.toHaveProperty("data");
    expect(thrownError).not.toHaveProperty("request");
  });

  it("does not read or mutate authentication state in localStorage", async () => {
    window.localStorage.setItem("token", "existing-token");
    window.localStorage.setItem("role", "user");
    const before = {
      token: window.localStorage.getItem("token"),
      role: window.localStorage.getItem("role"),
    };
    const logoutListener = vi.fn();
    window.addEventListener("prepx:logout", logoutListener);
    fetch.mockResolvedValue(jsonResponse(IDENTITY));

    await getAdminIdentity(TOKEN);

    expect(window.localStorage.getItem("token")).toBe(before.token);
    expect(window.localStorage.getItem("role")).toBe(before.role);
    expect(logoutListener).not.toHaveBeenCalled();
    window.removeEventListener("prepx:logout", logoutListener);
  });
});
