import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticatedRequestError,
  authenticatedRequest,
} from "./authenticatedRequest.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCapability({
  current = true,
  fetch = vi.fn(),
} = {}) {
  return {
    isCurrent: vi.fn(() => current),
    fetch,
  };
}

function jsonResponse(data, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    text: vi.fn(async () => JSON.stringify(data)),
  };
}

function emptyResponse({ status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, text: vi.fn(async () => "") };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("authenticatedRequest capability validation", () => {
  it("rejects a missing capability", async () => {
    await expect(authenticatedRequest(null, "/api/test")).rejects.toMatchObject({
      category: "missing-capability",
    });
  });

  it("rejects an invalid capability", async () => {
    await expect(authenticatedRequest({}, "/api/test")).rejects.toMatchObject({
      category: "invalid-capability",
    });
  });

  it("rejects a stale capability before dispatch", async () => {
    const capability = createCapability({ current: false });
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "stale-session",
    });
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("executes through capability.fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const capability = createCapability({ fetch });
    await expect(authenticatedRequest(capability, "/api/test")).resolves.toEqual({
      status: 200,
      data: { success: true },
    });
  });

  it("does not use native fetch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: true })),
    });
    await authenticatedRequest(capability, "/api/test");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("authenticatedRequest forwarding", () => {
  it("forwards URL and supported options without mutation", async () => {
    const controller = new AbortController();
    const headers = { "Content-Type": "application/json", "X-Request": "1" };
    const options = {
      method: "PATCH",
      body: JSON.stringify({ answer: "draft" }),
      signal: controller.signal,
      keepalive: true,
      headers,
    };
    const fetch = vi.fn().mockResolvedValue(emptyResponse());
    const capability = createCapability({ fetch });

    await authenticatedRequest(capability, "/api/mock-sessions/1", options);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/mock-sessions/1");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      body: options.body,
      signal: controller.signal,
      keepalive: true,
    });
    expect(fetch.mock.calls[0][1].headers).toBeInstanceOf(Headers);
    expect(options.headers).toBe(headers);
    expect(options).toEqual({
      method: "PATCH",
      body: JSON.stringify({ answer: "draft" }),
      signal: controller.signal,
      keepalive: true,
      headers,
    });
  });

  it("does not retry requests", async () => {
    const fetch = vi.fn().mockRejectedValue({
      category: "network-error",
    });
    const capability = createCapability({ fetch });
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "network-error",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("authenticatedRequest response parsing", () => {
  it("returns valid JSON success data", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ interviews: [1, 2] }, { status: 200 })),
    });
    await expect(authenticatedRequest(capability, "/api/interviews")).resolves.toEqual({
      status: 200,
      data: { interviews: [1, 2] },
    });
  });

  it("handles empty successful bodies", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(emptyResponse()),
    });
    await expect(authenticatedRequest(capability, "/api/test")).resolves.toEqual({
      status: 200,
      data: null,
    });
  });

  it.each([204, 205])("handles HTTP %i without reading the body", async (status) => {
    const response = { ok: true, status, text: vi.fn() };
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(response),
    });
    await expect(authenticatedRequest(capability, "/api/test")).resolves.toEqual({
      status,
      data: null,
    });
    expect(response.text).not.toHaveBeenCalled();
  });

  it("rejects malformed successful JSON", async () => {
    const response = { ok: true, status: 200, text: vi.fn(async () => "<html>bad</html>") };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "malformed-response",
      status: 200,
    });
  });

  it("normalizes non-JSON error responses without exposing the body", async () => {
    const response = {
      ok: false,
      status: 404,
      text: vi.fn(async () => "<html>private backend detail</html>"),
    };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "http-error",
      status: 404,
    });
  });

  it("normalizes response-body read failures", async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(new Error("synthetic-private-detail")),
    };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    const pending = authenticatedRequest(capability, "/api/test");
    await expect(pending).rejects.toMatchObject({
      category: "body-read-error",
      status: 200,
      message: "The authenticated response body could not be read.",
    });
    await expect(pending).rejects.not.toHaveProperty("data");
    await expect(pending).rejects.not.toHaveProperty("cause");
  });

  it("reads a response body only once", async () => {
    const response = jsonResponse({ value: 1 });
    await authenticatedRequest(createCapability({ fetch: vi.fn().mockResolvedValue(response) }), "/api/test");
    expect(response.text).toHaveBeenCalledTimes(1);
  });
});

describe("authenticatedRequest HTTP and capability errors", () => {
  it.each([400, 403, 404, 409, 429, 500, 503])(
    "preserves HTTP %i as a safe HTTP error",
    async (status) => {
      const capability = createCapability({
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status,
          text: vi.fn(async () => JSON.stringify({
            message: "Raw private backend detail",
            token: "synthetic-secret",
          })),
        }),
      });
      const error = await authenticatedRequest(capability, "/api/test").catch((caught) => caught);
      expect(error).toBeInstanceOf(AuthenticatedRequestError);
      expect(error).toMatchObject({ category: "http-error", status });
      expect(error.message).not.toContain("Raw private");
      expect(error.message).not.toContain("synthetic-secret");
    },
  );

  it("preserves capability unauthorized contract and status", async () => {
    const fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("private"), { category: "unauthorized", status: 401 }),
    );
    await expect(authenticatedRequest(createCapability({ fetch }), "/api/test")).rejects.toMatchObject({
      category: "unauthorized",
      status: 401,
    });
  });

  it("preserves capability administrator forbidden contract and status", async () => {
    const fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("private"), { category: "forbidden", status: 403 }),
    );
    await expect(authenticatedRequest(createCapability({ fetch }), "/api/admin/test")).rejects.toMatchObject({
      category: "forbidden",
      status: 403,
    });
  });

  it("preserves capability network failures", async () => {
    const fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("synthetic credentials"), { category: "network-error" }),
    );
    await expect(authenticatedRequest(createCapability({ fetch }), "/api/test")).rejects.toMatchObject({
      category: "network-error",
    });
  });

  it("preserves destination and stale capability errors", async () => {
    for (const category of ["invalid-destination", "stale-session"]) {
      const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("private"), { category }));
      await expect(authenticatedRequest(createCapability({ fetch }), "/api/test")).rejects.toMatchObject({
        category,
      });
    }
  });

  it("does not expose raw fetch errors or credentials", async () => {
    const fetch = vi.fn().mockRejectedValue(
      new Error("Authorization: Bearer synthetic-secret"),
    );
    const error = await authenticatedRequest(createCapability({ fetch }), "/api/test").catch((caught) => caught);
    expect(error.category).toBe("request-error");
    expect(error.message).not.toContain("Authorization");
    expect(error.message).not.toContain("synthetic-secret");
  });
});

describe("authenticatedRequest stale-response protection", () => {
  it("rejects stale success before parsing", async () => {
    let current = true;
    const body = deferred();
    const response = { ok: true, status: 200, text: vi.fn(() => body.promise) };
    const capability = createCapability({
      current,
      fetch: vi.fn().mockImplementation(async () => {
        current = false;
        return response;
      }),
    });
    capability.isCurrent = vi.fn(() => current);
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "stale-session",
    });
    expect(response.text).not.toHaveBeenCalled();
  });

  it("rejects success if currentness is lost during parsing", async () => {
    let current = true;
    const body = deferred();
    const response = { ok: true, status: 200, text: vi.fn(() => body.promise) };
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(response),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = authenticatedRequest(capability, "/api/test");
    current = false;
    body.resolve(JSON.stringify({ account: "old-account-secret" }));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
  });

  it("does not expose stale error response data", async () => {
    let current = true;
    const body = deferred();
    const response = {
      ok: false,
      status: 409,
      text: vi.fn(() => body.promise),
    };
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(response),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = authenticatedRequest(capability, "/api/test");
    current = false;
    body.resolve(JSON.stringify({ message: "old account detail", token: "synthetic-secret" }));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
  });

  it("preserves intentional 401 invalidation error", async () => {
    const capability = createCapability();
    capability.fetch.mockImplementation(async () => {
      capability.isCurrent.mockReturnValue(false);
      throw Object.assign(new Error("private"), { category: "unauthorized", status: 401 });
    });
    await expect(authenticatedRequest(capability, "/api/test")).rejects.toMatchObject({
      category: "unauthorized",
      status: 401,
    });
  });

  it("preserves intentional 403 invalidation error", async () => {
    const capability = createCapability();
    capability.fetch.mockImplementation(async () => {
      capability.isCurrent.mockReturnValue(false);
      throw Object.assign(new Error("private"), { category: "forbidden", status: 403 });
    });
    await expect(authenticatedRequest(capability, "/api/admin/test")).rejects.toMatchObject({
      category: "forbidden",
      status: 403,
    });
  });
});

describe("authenticatedRequest rejected body reads", () => {
  const lookupUrl = "http://localhost:5000/api/interviews/interview-1/sessions/in-progress";
  const answerUrl = "http://localhost:5000/api/mock-sessions/session-1/answers/question-1";

  it.each([
    { scenario: "a stale success response", url: "/api/test", method: "GET", status: 200, stale: true, abort: false },
    { scenario: "a stale in-progress lookup", url: lookupUrl, method: "GET", status: 404, stale: true, abort: false },
    { scenario: "a stale answer-save conflict", url: answerUrl, method: "PATCH", status: 409, stale: true, abort: false },
    { scenario: "a cancelled in-progress lookup", url: lookupUrl, method: "GET", status: 404, stale: false, abort: true },
    { scenario: "an answer save both stale and cancelled", url: answerUrl, method: "PATCH", status: 409, stale: true, abort: true },
  ])("classifies $scenario without retry or credential access", async ({ url, method, status, stale, abort }) => {
    const controller = new AbortController();
    const reading = deferred();
    const body = deferred();
    const text = vi.fn(() => {
      reading.resolve();
      return body.promise;
    });
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({ ok: status === 200, status, text }),
    });
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected native fetch"));
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clear = vi.spyOn(Storage.prototype, "clear");
    const logout = vi.fn();
    window.addEventListener("prepx:logout", logout);

    try {
      const pending = authenticatedRequest(capability, url, { method, signal: controller.signal });
      const rejected = pending.catch((error) => error);
      await reading.promise;
      if (stale) capability.isCurrent.mockReturnValue(false);
      if (abort) controller.abort();
      body.reject(new Error("synthetic-private-detail"));

      const error = await rejected;
      expect(error).toBeInstanceOf(AuthenticatedRequestError);
      expect(error).toMatchObject({
        category: abort ? "cancelled" : "stale-session",
        message: abort
          ? "The authenticated request was cancelled."
          : "The authentication session for this request is no longer current.",
      });
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("data");
      expect(error).not.toHaveProperty("cause");
      expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(url, { method, signal: controller.signal });
      expect(text).toHaveBeenCalledTimes(1);
      for (const spy of [nativeFetch, getItem, setItem, removeItem, clear, logout]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      window.removeEventListener("prepx:logout", logout);
    }
  });
});

describe("authenticatedRequest cancellation", () => {
  it("rejects a pre-aborted request without dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const capability = createCapability();
    await expect(authenticatedRequest(
      capability,
      "/api/test",
      { signal: controller.signal },
    )).rejects.toMatchObject({ category: "cancelled" });
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("distinguishes cancellation during fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("synthetic", "AbortError");
    });
    await expect(authenticatedRequest(
      createCapability({ fetch }),
      "/api/test",
      { signal: controller.signal },
    )).rejects.toMatchObject({ category: "cancelled" });
  });

  it("distinguishes cancellation during parsing", async () => {
    const controller = new AbortController();
    const body = deferred();
    const response = { ok: true, status: 200, text: vi.fn(() => body.promise) };
    const pending = authenticatedRequest(
      createCapability({ fetch: vi.fn().mockResolvedValue(response) }),
      "/api/test",
      { signal: controller.signal },
    );
    controller.abort();
    body.resolve(JSON.stringify({ late: true }));
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });

  it("does not accept late body resolution after cancellation", async () => {
    const controller = new AbortController();
    const body = deferred();
    const response = { ok: true, status: 200, text: vi.fn(() => body.promise) };
    const pending = authenticatedRequest(
      createCapability({ fetch: vi.fn().mockResolvedValue(response) }),
      "/api/test",
      { signal: controller.signal },
    );
    controller.abort();
    body.resolve(JSON.stringify({ late: true }));
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });
});

describe("authenticatedRequest architecture", () => {
  it("does not dispatch logout events or modify localStorage", async () => {
    window.localStorage.setItem("token", "synthetic-secret");
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ success: true })),
    });
    const logout = vi.fn();
    window.addEventListener("prepx:logout", logout);
    await authenticatedRequest(capability, "/api/test");
    window.removeEventListener("prepx:logout", logout);
    expect(logout).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("token")).toBe("synthetic-secret");
  });
});

describe("recognized no-in-progress-session HTTP 404 metadata", () => {
  const inProgressUrl = "http://localhost:5000/api/interviews/interview-1/sessions/in-progress";
  const notFoundBody = {
    success: false,
    message: "No in-progress session found",
  };

  it("normalizes the exact no-in-progress-session response", async () => {
    const response = {
      ok: false,
      status: 404,
      text: vi.fn(async () => JSON.stringify({
        ...notFoundBody,
        errorCode: "backend_private_code",
        nested: { secret: "Bearer synthetic-secret" },
        secret: "raw-secret",
      })),
    };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    const error = await authenticatedRequest(
      capability,
      inProgressUrl,
      { method: "GET" },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(AuthenticatedRequestError);
    expect(error).toMatchObject({
      category: "http-error",
      status: 404,
      data: { errorCode: "no_in_progress_session" },
    });
    expect(error.message).toBe("The authenticated request failed.");
    expect(error.data).toEqual({ errorCode: "no_in_progress_session" });
    expect(JSON.stringify(error)).not.toContain("backend_private_code");
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    expect(JSON.stringify(error)).not.toContain("raw-secret");
    expect(response.text).toHaveBeenCalledTimes(1);
  });

  it.each([
    [inProgressUrl, "GET", 404, { success: false, message: "Interview not found" }],
    [inProgressUrl, "GET", 404, { success: false, message: "Mock interview session not found" }],
    [inProgressUrl, "GET", 404, { success: false, message: "No in-progress sessions found" }],
    ["http://localhost:5000/api/interviews/interview-1/sessions/in-progress-extra", "GET", 404, notFoundBody],
    ["http://localhost:5000/api/interviews-extra/interview-1/sessions/in-progress", "GET", 404, notFoundBody],
    ["http://localhost:5000/api/mock-sessions/session-1", "GET", 404, notFoundBody],
    [inProgressUrl, "POST", 404, notFoundBody],
    [inProgressUrl, "GET", 400, notFoundBody],
    [inProgressUrl, "GET", 500, notFoundBody],
    [inProgressUrl, "GET", 404, { success: true, message: notFoundBody.message }],
  ])("does not recognize generic 404 boundary case", async (url, method, status, body) => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: vi.fn(async () => JSON.stringify(body)),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      url,
      { method },
    ).catch((caught) => caught);
    expect(error.category).toBe("http-error");
    expect(error.status).toBe(status);
    expect(error.data).toBeUndefined();
  });

  it("does not recognize malformed JSON", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(async () => "<html>No in-progress session found</html>"),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      inProgressUrl,
      { method: "GET" },
    ).catch((caught) => caught);
    expect(error.category).toBe("http-error");
    expect(error.status).toBe(404);
    expect(error.data).toBeUndefined();
  });

  it("does not recognize a non-JSON array response", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(async () => JSON.stringify([notFoundBody])),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      inProgressUrl,
      { method: "GET" },
    ).catch((caught) => caught);
    expect(error.category).toBe("http-error");
    expect(error.status).toBe(404);
    expect(error.data).toBeUndefined();
  });

  it("rejects the recognized 404 after session replacement as stale", async () => {
    let current = true;
    const body = deferred();
    const response = {
      ok: false,
      status: 404,
      text: vi.fn(() => body.promise),
    };
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(response),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = authenticatedRequest(
      capability,
      inProgressUrl,
      { method: "GET" },
    );
    current = false;
    body.resolve(JSON.stringify(notFoundBody));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
  });

  it("does not expose 404 metadata after cancellation during parsing", async () => {
    const controller = new AbortController();
    const body = deferred();
    const response = {
      ok: false,
      status: 404,
      text: vi.fn(() => body.promise),
    };
    const pending = authenticatedRequest(
      createCapability({ fetch: vi.fn().mockResolvedValue(response) }),
      inProgressUrl,
      { method: "GET", signal: controller.signal },
    );
    controller.abort();
    body.resolve(JSON.stringify(notFoundBody));
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });
});

describe("recognized completed-session HTTP 409 metadata", () => {
  const completedUrl = "http://localhost:5000/api/mock-sessions/session-1/answers/question-1";
  const completedBody = {
    success: false,
    message: "Completed sessions cannot be modified",
  };

  it("normalizes the exact completed-session conflict", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn(async () => JSON.stringify(completedBody)),
      }),
    });

    const error = await authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      category: "http-error",
      status: 409,
      data: { errorCode: "session_completed" },
    });
  });

  it("discards additional backend fields and raw credentials", async () => {
    const response = {
      ok: false,
      status: 409,
      text: vi.fn(async () => JSON.stringify({
        ...completedBody,
        errorCode: "backend_private_code",
        nested: { secret: "Bearer synthetic-secret" },
      })),
    };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    const error = await authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    ).catch((caught) => caught);

    expect(error.data).toEqual({ errorCode: "session_completed" });
    expect(JSON.stringify(error)).not.toContain("backend_private_code");
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });

  it.each([
    ["/api/mock-sessions/session-1/answers/question-1", "GET", 409, completedBody],
    ["http://localhost:5000/api/mock-sessions/session-1/evaluation", "POST", 409, completedBody],
    ["http://localhost:5000/api/interviews/interview-1/sessions", "POST", 409, completedBody],
    [completedUrl, "PATCH", 500, completedBody],
    [completedUrl, "PATCH", 409, { success: false, message: "Some other conflict" }],
    [completedUrl, "PATCH", 409, { success: true, message: completedBody.message }],
    [completedUrl, "PATCH", 409, { success: false, message: "Completed sessions cannot be modify" }],
  ])("does not recognize generic boundary case", async (url, method, status, body) => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: vi.fn(async () => JSON.stringify(body)),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      url,
      { method },
    ).catch((caught) => caught);

    expect(error.category).toBe(status >= 500 ? "http-error" : "http-error");
    expect(error.status).toBe(status);
    expect(error.data).toBeUndefined();
  });

  it("does not match a similarly named endpoint", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn(async () => JSON.stringify(completedBody)),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      "http://localhost:5000/api/mock-sessions-extra/session-1/answers/question-1",
      { method: "PATCH" },
    ).catch((caught) => caught);
    expect(error.data).toBeUndefined();
  });

  it("does not recognize malformed JSON", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn(async () => "<html>Completed sessions cannot be modified</html>"),
      }),
    });
    await expect(authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    )).rejects.toMatchObject({ category: "http-error", status: 409 });
  });

  it("does not recognize a non-JSON array response", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn(async () => JSON.stringify([completedBody])),
      }),
    });
    const error = await authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    ).catch((caught) => caught);
    expect(error.data).toBeUndefined();
  });

  it("reads the error body only once", async () => {
    const response = {
      ok: false,
      status: 409,
      text: vi.fn(async () => JSON.stringify(completedBody)),
    };
    const capability = createCapability({ fetch: vi.fn().mockResolvedValue(response) });
    await authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    ).catch(() => {});
    expect(response.text).toHaveBeenCalledTimes(1);
  });

  it("rejects a recognized conflict after session replacement as stale", async () => {
    let current = true;
    const body = deferred();
    const response = {
      ok: false,
      status: 409,
      text: vi.fn(() => body.promise),
    };
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(response),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = authenticatedRequest(
      capability,
      completedUrl,
      { method: "PATCH" },
    );
    current = false;
    body.resolve(JSON.stringify(completedBody));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
  });

  it("does not expose conflict metadata after cancellation during parsing", async () => {
    const controller = new AbortController();
    const body = deferred();
    const response = {
      ok: false,
      status: 409,
      text: vi.fn(() => body.promise),
    };
    const pending = authenticatedRequest(
      createCapability({ fetch: vi.fn().mockResolvedValue(response) }),
      completedUrl,
      { method: "PATCH", signal: controller.signal },
    );
    controller.abort();
    body.resolve(JSON.stringify(completedBody));
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });
});
