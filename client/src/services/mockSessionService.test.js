import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";
import {
  completeMockSession,
  createMockSession,
  findInProgressMockSession,
  getMockSession,
  saveMockSessionAnswer,
} from "./mockSessionService.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    text: vi.fn(async () => JSON.stringify(data)),
  };
}

function createCapability({ current = true, fetch = vi.fn() } = {}) {
  return {
    isCurrent: vi.fn(() => current),
    fetch,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("token", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("mockSessionService legacy compatibility", () => {
  it("preserves all existing operation signatures and successful shapes", async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ session: { _id: "session-1" } }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ session: { _id: "session-1" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, saveStatus: "saved" }))
      .mockResolvedValueOnce(jsonResponse({ session: { _id: "session-1", status: "completed" } }))
      .mockResolvedValueOnce(jsonResponse({ session: { _id: "session-1", status: "in-progress" } }));

    await expect(createMockSession("interview-1")).resolves.toEqual({ _id: "session-1" });
    await expect(getMockSession("session-1")).resolves.toEqual({ _id: "session-1" });
    await expect(saveMockSessionAnswer("session-1", "question-1", "Answer")).resolves.toEqual({
      success: true,
      saveStatus: "saved",
    });
    await expect(completeMockSession("session-1")).resolves.toEqual({
      _id: "session-1",
      status: "completed",
    });
    await expect(findInProgressMockSession("interview-1")).resolves.toEqual({
      _id: "session-1",
      status: "in-progress",
    });
  });

  it("preserves legacy Authorization and JSON headers", async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ session: { _id: "session-1" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, saveStatus: "saved" }));

    await createMockSession("interview-1");
    await saveMockSessionAnswer("session-1", "question-1", "Answer");

    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-token");
    expect(fetch.mock.calls[1][1].headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic-token",
    });
  });

  it("preserves legacy keepalive defaults and explicit values", async () => {
    fetch.mockResolvedValue(jsonResponse({ success: true }));

    await saveMockSessionAnswer("session-1", "question-1", "Default");
    await saveMockSessionAnswer("session-1", "question-1", "Enabled", { keepalive: true });
    await saveMockSessionAnswer("session-1", "question-1", "Disabled", { keepalive: false });

    expect(fetch.mock.calls[0][1].keepalive).toBe(false);
    expect(fetch.mock.calls[1][1].keepalive).toBe(true);
    expect(fetch.mock.calls[2][1].keepalive).toBe(false);
  });

  it("preserves legacy HTTP status and message behavior", async () => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: "Completed sessions cannot be modified" },
      { status: 409, ok: false },
    ));

    await expect(saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
    )).rejects.toMatchObject({
      status: 409,
      message: "Completed sessions cannot be modified",
    });
  });
});

describe("mockSessionService capability-bound operations", () => {
  it("creates a session through the supplied capability", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { session: { _id: "session-1" } },
        { status: 201 },
      )),
    });

    await expect(createMockSession("interview-1", { capability })).resolves.toEqual({
      _id: "session-1",
    });
    expect(capability.fetch).toHaveBeenCalledWith(
      "http://localhost:5000/api/interviews/interview-1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loads a session through the supplied capability", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ session: { _id: "session-1" } })),
    });
    await expect(getMockSession("session-1", { capability })).resolves.toEqual({ _id: "session-1" });
  });

  it("saves an answer through the supplied capability", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        success: true,
        saveStatus: "saved",
      })),
    });
    await expect(saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability, keepalive: true },
    )).resolves.toEqual({ success: true, saveStatus: "saved" });

    expect(capability.fetch.mock.calls[0][0]).toBe(
      "http://localhost:5000/api/mock-sessions/session-1/answers/question-1",
    );
    expect(capability.fetch.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ answerText: "Answer" }),
      keepalive: true,
    });
  });

  it("completes a session through the supplied capability", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        session: { _id: "session-1", status: "completed" },
      })),
    });
    await expect(completeMockSession("session-1", { capability })).resolves.toEqual({
      _id: "session-1",
      status: "completed",
    });
  });

  it("finds an in-progress session through the supplied capability", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        session: { _id: "session-1", status: "in-progress" },
      })),
    });
    await expect(findInProgressMockSession("interview-1", { capability })).resolves.toEqual({
      _id: "session-1",
      status: "in-progress",
    });
  });

  it("preserves keepalive false and caller AbortSignal", async () => {
    const controller = new AbortController();
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ success: true })),
    });
    await saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability, keepalive: false, signal: controller.signal },
    );
    expect(capability.fetch.mock.calls[0][1]).toMatchObject({
      keepalive: false,
      signal: controller.signal,
    });
  });
});

describe("mockSessionService credential isolation", () => {
  it.each([
    [null],
    [undefined],
  ])("explicit %s capability does not fall back", async (capability) => {
    await expect(findInProgressMockSession("interview-1", { capability })).rejects.toMatchObject({
      category: "missing-capability",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalid capability does not fall back", async () => {
    await expect(findInProgressMockSession("interview-1", { capability: {} })).rejects.toMatchObject({
      category: "invalid-capability",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a stale lookup capability before either fetch can dispatch", async () => {
    const capability = createCapability({ current: false });
    await expect(findInProgressMockSession("interview-1", { capability }))
      .rejects.toMatchObject({ category: "stale-session" });
    expect(capability.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stale capability does not fall back or dispatch", async () => {
    const capability = createCapability({ current: false });
    await expect(saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability, keepalive: true },
    )).rejects.toMatchObject({ category: "stale-session" });
    expect(capability.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not read replacement localStorage credentials", async () => {
    window.localStorage.setItem("token", "replacement-token");
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ success: true })),
    });
    await saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability },
    );
    expect(window.localStorage.getItem("token")).toBe("replacement-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects pre-aborted capability requests without dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const capability = createCapability();
    await expect(saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability, signal: controller.signal },
    )).rejects.toMatchObject({ category: "cancelled" });
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("does not mutate caller options", async () => {
    const controller = new AbortController();
    const options = {
      capability: createCapability({
        fetch: vi.fn().mockResolvedValue(jsonResponse({ success: true })),
      }),
      keepalive: true,
      signal: controller.signal,
    };
    const original = { ...options };
    await saveMockSessionAnswer("session-1", "question-1", "Answer", options);
    expect(options.keepalive).toBe(original.keepalive);
    expect(options.signal).toBe(original.signal);
    expect(options.capability).toBe(original.capability);
  });

  it("does not retry capability requests", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockRejectedValue({ category: "network-error" }),
    });
    await expect(getMockSession("session-1", { capability })).rejects.toMatchObject({
      category: "network-error",
    });
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("mockSessionService conflict and error compatibility", () => {
  it("maps the exact capability-bound 404 to the fixed legacy message", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "No in-progress session found", detail: "synthetic-secret" },
        { status: 404, ok: false },
      )),
    });
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    try {
      const pending = findInProgressMockSession("interview-1", { capability });
      await expect(pending).rejects.toBeInstanceOf(AuthenticatedRequestError);
      const error = await pending.catch((caught) => caught);
      expect(error).toMatchObject({
        name: "AuthenticatedRequestError",
        category: "http-error",
        status: 404,
        message: "No in-progress session found",
      });
      expect(error.data).toEqual({ errorCode: "no_in_progress_session" });
      expect(Object.isFrozen(error.data)).toBe(true);
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
      expect(capability.fetch).toHaveBeenCalledTimes(1);
      expect(readStorage).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      readStorage.mockRestore();
    }
  });

  it.each([
    [{ success: false, message: "Interview not found" }, 404],
    [{ success: false, message: "Mock interview session not found" }, 404],
    [{ success: false, message: "No in-progress sessions found" }, 404],
    [{ success: true, message: "No in-progress session found" }, 404],
    [[], 404],
    [{ errorCode: "unexpected_code", message: "Backend private detail" }, 404],
    [{ errorCode: "no_in_progress_session", message: "Backend private detail" }, 404],
    [{ success: false, message: "No in-progress session found" }, 400],
  ])("does not map other 404 and response boundary cases", async (body, status) => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(body, { status, ok: status >= 200 && status < 300 })),
    });
    const error = await findInProgressMockSession(
      "interview-1",
      { capability },
    ).catch((caught) => caught);
    expect(error.status).toBe(status);
    expect(error.category).toBe("http-error");
    expect(error.data).toBeUndefined();
    expect(error.message).toBe("The authenticated request failed.");
  });

  it("does not map matching 404 response bodies from unrelated operations", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "No in-progress session found" },
        { status: 404, ok: false },
      )),
    });
    const error = await getMockSession("session-1", { capability }).catch((caught) => caught);
    expect(error.status).toBe(404);
    expect(error.data).toBeUndefined();
    expect(error.message).toBe("The authenticated request failed.");
  });

  it("does not map malformed JSON or HTML", async () => {
    for (const text of ["<html>No in-progress session found</html>", "{malformed"]) {
      const capability = createCapability({
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: vi.fn(async () => text),
        }),
      });
      const error = await findInProgressMockSession(
        "interview-1",
        { capability },
      ).catch((caught) => caught);
      expect(error.status).toBe(404);
      expect(error.category).toBe("http-error");
      expect(error.data).toBeUndefined();
      expect(error.message).not.toContain("in-progress");
    }
  });

  it("preserves legacy no-in-progress-session behavior", async () => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: "No in-progress session found" },
      { status: 404, ok: false },
    ));
    await expect(findInProgressMockSession("interview-1")).rejects.toMatchObject({
      status: 404,
      message: "No in-progress session found",
    });
  });

  it("preserves legacy interview-not-found behavior", async () => {
    fetch.mockResolvedValue(jsonResponse(
      { success: false, message: "Interview not found" },
      { status: 404, ok: false },
    ));
    await expect(findInProgressMockSession("interview-1")).rejects.toMatchObject({
      status: 404,
      message: "Interview not found",
    });
  });

  it("does not expose stale recognized 404 metadata", async () => {
    let current = true;
    const body = deferred();
    const readingBody = deferred();
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(() => {
          readingBody.resolve();
          return body.promise;
        }),
      }),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = findInProgressMockSession("interview-1", { capability });
    await readingBody.promise;
    current = false;
    body.resolve(JSON.stringify({
      success: false,
      message: "No in-progress session found",
    }));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
    await expect(pending).rejects.not.toHaveProperty("data");
    expect(capability.fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose recognized 404 metadata after cancellation", async () => {
    const controller = new AbortController();
    const body = deferred();
    const readingBody = deferred();
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(() => {
          readingBody.resolve();
          return body.promise;
        }),
      }),
    });
    const pending = findInProgressMockSession("interview-1", {
      capability,
      signal: controller.signal,
    });
    await readingBody.promise;
    controller.abort();
    body.resolve(JSON.stringify({
      success: false,
      message: "No in-progress session found",
    }));
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    await expect(pending).rejects.not.toHaveProperty("data");
    expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:5000/api/interviews/interview-1/sessions/in-progress",
      { method: "GET", signal: controller.signal },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps recognized session_completed metadata to the legacy completion message", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "Completed sessions cannot be modified" },
        { status: 409, ok: false },
      )),
    });

    await expect(saveMockSessionAnswer(
      "session-1",
      "question-1",
      "Answer",
      { capability },
    )).rejects.toMatchObject({
      status: 409,
      category: "http-error",
      message: "Completed sessions cannot be modified",
      data: { errorCode: "session_completed" },
    });
  });

  it("does not classify generic 409 responses as completed sessions", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "Session could not be completed" },
        { status: 409, ok: false },
      )),
    });
    const error = await saveMockSessionAnswer("session-1", "question-1", "Answer", { capability })
      .catch((caught) => caught);
    expect(error.status).toBe(409);
    expect(error.category).toBe("http-error");
    expect(error.data).toBeUndefined();
    expect(error.message).toBe("The authenticated request failed.");
  });

  it("does not apply completed-session mapping outside answer-save operations", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "Completed sessions cannot be modified" },
        { status: 409, ok: false },
      )),
    });
    const error = await completeMockSession("session-1", { capability }).catch((caught) => caught);
    expect(error.status).toBe(409);
  });

  it("preserves other 404 meaning instead of reclassifying it", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "Interview not found" },
        { status: 404, ok: false },
      )),
    });
    await expect(findInProgressMockSession("interview-1", { capability })).rejects.toMatchObject({
      category: "http-error",
      status: 404,
    });
  });

  it.each([401, 403, 500, 503])("preserves capability HTTP %i", async (status) => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse(
        { success: false, message: "Backend private detail", token: "synthetic-secret" },
        { status, ok: false },
      )),
    });
    const error = await getMockSession("session-1", { capability }).catch((caught) => caught);
    expect(error.status).toBe(status);
    expect(error.category).toBe("http-error");
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    expect(JSON.stringify(error)).not.toContain("Backend private detail");
  });

  it("preserves network failures", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockRejectedValue({ category: "network-error" }),
    });
    await expect(getMockSession("session-1", { capability })).rejects.toMatchObject({
      category: "network-error",
    });
  });

  it("rejects malformed successful capability responses", async () => {
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ success: true })),
    });
    await expect(getMockSession("session-1", { capability })).rejects.toThrow(
      "mock interview session",
    );
  });

  it("rejects stale successful capability responses", async () => {
    let current = true;
    const body = deferred();
    const capability = createCapability({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn(() => body.promise),
      }),
    });
    capability.isCurrent = vi.fn(() => current);
    const pending = getMockSession("session-1", { capability });
    current = false;
    body.resolve(JSON.stringify({ session: { _id: "old-account-session" } }));
    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
  });

  it("handles capability cancellation distinctly", async () => {
    const controller = new AbortController();
    const capability = createCapability({
      fetch: vi.fn().mockRejectedValue({
        category: "cancelled",
        name: "AbortError",
      }),
    });
    await expect(getMockSession("session-1", {
      capability,
      signal: controller.signal,
    })).rejects.toMatchObject({ category: "cancelled" });
  });
});
