import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEvaluationStatus, getInterviewResult, getInterviewResults, requestEvaluation } from "./resultService.js";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(data) };
}

beforeEach(() => {
  window.localStorage.setItem("token", "test-token");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("resultService", () => {
  it.each([false, true])("sends the explicit retry boolean %s", async (retry) => {
    fetch.mockResolvedValue(jsonResponse({ success: true, status: "pending" }, { status: 202 }));
    const response = await requestEvaluation("result-id", retry);
    expect(response.status).toBe("pending");
    expect(fetch).toHaveBeenCalledWith("http://localhost:5000/api/mock-sessions/result-id/evaluation", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ retry }),
      headers: expect.objectContaining({ Authorization: "Bearer test-token", "Content-Type": "application/json" }),
    }));
  });

  it("rejects a non-boolean retry before making a request", async () => {
    await expect(requestEvaluation("result-id", undefined)).rejects.toThrow("Retry must be an explicit boolean");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads persisted result history and individual evaluation status", async () => {
    const savedResult = { _id: "result-id", status: "completed" };
    fetch
      .mockResolvedValueOnce(jsonResponse({ results: [savedResult] }))
      .mockResolvedValueOnce(jsonResponse({ result: savedResult }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", evaluation: { overallScore: 88 } }));

    await expect(getInterviewResults()).resolves.toEqual([savedResult]);
    await expect(getInterviewResult("result-id")).resolves.toEqual(savedResult);
    await expect(getEvaluationStatus("result-id")).resolves.toMatchObject({ status: "completed", evaluation: { overallScore: 88 } });
  });

  it("preserves unauthorized response details for the page to handle", async () => {
    fetch.mockResolvedValue(jsonResponse({ success: false, message: "Access denied" }, { ok: false, status: 401 }));
    await expect(getInterviewResults()).rejects.toMatchObject({ status: 401, message: "Access denied" });
  });
});

const baseUrl = "http://localhost:5000/api";
const resultId = "a".repeat(24);
const resultPath = "/results/" + resultId;
const evaluationPath = "/mock-sessions/" + resultId + "/evaluation";
const savedAnswer = {
  question: "b".repeat(24), questionText: "Explain a hash map.", category: "Technical",
  difficulty: "Intermediate", order: 1, answerText: "", score: 0, answerScore: null,
};
const unevaluated = {
  _id: resultId, status: "in-progress", interview: { _id: "c".repeat(24), title: "Frontend practice" },
  durationSeconds: null, totalQuestions: 1, totalScore: 0, answers: [savedAnswer],
};
const evaluation = {
  _id: resultId, status: "completed", evaluationStatus: "completed", evaluationAttemptCount: 2,
  durationSeconds: 30, overallScore: 0, performanceRating: "needs-practice", overallFeedback: "Practice key concepts.",
  recommendedLearningTopics: ["Hash maps"],
  answers: [{ ...savedAnswer, answerScore: 0, dimensions: [{ key: "clarity", score: 0, weight: 1, rationale: "" }] }],
};
const pending = { success: true, status: "pending", attemptCount: 1 };
const completed = { success: true, status: "completed", attemptCount: 2, evaluation };
const failed = {
  success: true, status: "failed", attemptCount: 3, retryAvailable: false,
  errorCode: "invalid_output", message: "Evaluation failed. You can retry this evaluation.",
};

const operations = [
  ["history", "/results", (options) => getInterviewResults(options)],
  ["detail", resultPath, (options) => getInterviewResult(resultId, options)],
  ["status", evaluationPath, (options) => getEvaluationStatus(resultId, options)],
  ["submission", evaluationPath, (options) => requestEvaluation(resultId, false, options)],
];

function controlledCapability(transport = vi.fn()) {
  let current = true;
  const capability = {
    isCurrent: () => current,
    fetch: vi.fn((url, options) => {
      const headers = new Headers(options.headers);
      headers.set("Authorization", "Bearer synthetic-result-token");
      return transport(url, { ...options, headers });
    }),
  };
  return { capability, transport, invalidate: () => { current = false; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("legacy compatibility", () => {
  it.each(operations)("uses the existing %s endpoint with an inherited capability", async (name, path, call) => {
    const inherited = controlledCapability().capability;
    fetch.mockResolvedValue(jsonResponse({ results: [], result: unevaluated, ...pending }));
    await call(Object.create({ capability: inherited }));
    expect(inherited.fetch).not.toHaveBeenCalled();
    const submission = name === "submission";
    expect(fetch).toHaveBeenCalledExactlyOnceWith(baseUrl + path, submission ? {
      method: "POST", body: '{"retry":false}',
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    } : { headers: { Authorization: "Bearer test-token" } });
  });

  it("retains legacy ID encoding, empty fallback, and evaluation error bodies", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(getInterviewResults()).resolves.toEqual([]);
    const body = { ...failed, success: false };
    fetch.mockResolvedValueOnce(jsonResponse(body, { ok: false, status: 409 }));
    await expect(requestEvaluation(" a/b ", true)).rejects.toMatchObject({
      status: 409, data: body, message: body.message,
    });
    expect(fetch.mock.lastCall[0]).toBe(baseUrl + "/mock-sessions/a%2Fb/evaluation");
  });
});

describe("capability-bound result operations", () => {
  let readStorage;
  let logout;

  beforeEach(() => {
    readStorage = vi.spyOn(Storage.prototype, "getItem");
    logout = vi.fn();
    window.addEventListener("prepx:logout", logout);
  });

  afterEach(() => {
    window.removeEventListener("prepx:logout", logout);
    try {
      expect(readStorage).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
    } finally {
      readStorage.mockRestore();
    }
  });

  it.each([
    ["history", "/results", getInterviewResults, { success: true, count: 2, results: [unevaluated, evaluation] }, [unevaluated, evaluation]],
    ["empty history", "/results", getInterviewResults, { success: true, count: 0, results: [] }, []],
    ["detail", resultPath, (options) => getInterviewResult(resultId, options), { success: true, result: { ...unevaluated, overallScore: null } }, { ...unevaluated, overallScore: null }],
    ...[
      { success: true, status: "not-requested", attemptCount: 0 },
      pending, completed, failed, { ...failed, attemptCount: 2, retryAvailable: true },
    ].map((state) => [
      "status " + state.status + " after " + state.attemptCount + " attempts",
      evaluationPath, (options) => getEvaluationStatus(resultId, options), state, state,
    ]),
  ])("returns %s intact and forwards the authorized GET", async (_name, path, call, body, expected) => {
    const { capability, transport } = controlledCapability();
    const { signal } = new AbortController();
    transport.mockResolvedValue(jsonResponse(body));
    await expect(call({ capability, signal })).resolves.toEqual(expected);
    expect(transport).toHaveBeenCalledExactlyOnceWith(baseUrl + path, {
      method: "GET", signal, headers: new Headers({ Authorization: "Bearer synthetic-result-token" }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[false, 202, pending], [true, 200, completed]])("submits retry=%s exactly once and accepts HTTP %i", async (retry, status, body) => {
    const { capability, transport } = controlledCapability();
    const { signal } = new AbortController();
    transport.mockResolvedValue(jsonResponse(body, { status }));
    await expect(requestEvaluation(resultId, retry, { capability, signal })).resolves.toEqual(body);
    expect(transport).toHaveBeenCalledExactlyOnceWith(baseUrl + evaluationPath, {
      method: "POST", signal, body: JSON.stringify({ retry }),
      headers: new Headers({ Authorization: "Bearer synthetic-result-token", "Content-Type": "application/json" }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(operations)("fails closed for explicit missing, invalid, and stale %s capabilities", async (_name, _path, call) => {
    const { capability, invalidate } = controlledCapability();
    invalidate();
    for (const [value, category] of [
      [undefined, "missing-capability"], [null, "missing-capability"], [{}, "invalid-capability"],
      [capability, "stale-session"],
    ]) {
      await expect(call({ capability: value })).rejects.toMatchObject({ category });
    }
    expect(capability.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "../other", "two/segments", "a%2Fb", "a%5Cb", "a\\b", "a?query=1", "a#fragment", "a\n", "a\u0000", " safe "])(
    "rejects unsafe IDs before dispatch (%j)", async (id) => {
      const { capability } = controlledCapability();
      const options = { capability };
      for (const call of [getInterviewResult(id, options), getEvaluationStatus(id, options), requestEvaluation(id, false, options)]) {
        await expect(call).rejects.toMatchObject({ category: "invalid-destination" });
      }
      expect(capability.fetch).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("leaves safe-segment ObjectId validation to the backend and validates retry locally", async () => {
    const { capability, transport } = controlledCapability();
    transport.mockResolvedValue(jsonResponse({ message: "Invalid session ID" }, { ok: false, status: 400 }));
    await expect(getEvaluationStatus("invalid_id-1", { capability })).rejects.toMatchObject({ category: "http-error", status: 400 });
    await expect(requestEvaluation(resultId, "true", { capability })).rejects.toMatchObject({ category: "invalid-request-options" });
    expect(transport).toHaveBeenCalledExactlyOnceWith(baseUrl + "/mock-sessions/invalid_id-1/evaluation", expect.objectContaining({ method: "GET" }));
  });

  it.each([
    [getInterviewResults, { success: true }, 200],
    [getInterviewResults, { success: true, results: [null] }, 200],
    [getInterviewResults, { success: false, results: [] }, 200],
    [(options) => getInterviewResult(resultId, options), { success: true, result: { ...unevaluated, answers: {} } }, 200],
    [(options) => getEvaluationStatus(resultId, options), { ...failed, retryAvailable: "yes" }, 200],
    [(options) => getEvaluationStatus(resultId, options), { ...pending, attemptCount: -1 }, 200],
    [(options) => getEvaluationStatus(resultId, options), { ...pending, status: "unknown" }, 200],
    [(options) => getEvaluationStatus(resultId, options), { ...completed, evaluation: null }, 200],
    [(options) => requestEvaluation(resultId, false, options), completed, 202],
    [(options) => requestEvaluation(resultId, false, options), failed, 200],
    [(options) => requestEvaluation(resultId, false, options), null, 204],
  ])("rejects a malformed success envelope (%#)", async (call, body, status) => {
    const { capability, transport } = controlledCapability();
    transport.mockResolvedValue(jsonResponse(body, { status }));
    await expect(call({ capability })).rejects.toMatchObject({ category: "malformed-response", status });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 404, 409, 429, 502, 503])("keeps POST HTTP %i structured without replay or status GET", async (status) => {
    const { capability, transport } = controlledCapability();
    transport.mockResolvedValue(jsonResponse({ ...failed, success: false, message: "Private backend body" }, { ok: false, status }));
    const outcome = requestEvaluation(resultId, true, { capability });
    await expect(outcome).rejects.toMatchObject({ category: "http-error", status });
    await expect(outcome).rejects.not.toHaveProperty("data");
    await expect(outcome).rejects.not.toHaveProperty("message", "Private backend body");
    expect(capability.isCurrent()).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([["unauthorized", 401], ["forbidden", 403], ["network-error", undefined]])(
    "preserves a provider-owned %s error and makes one attempt", async (category, status) => {
      const { capability, transport } = controlledCapability();
      transport.mockRejectedValue(new AuthenticatedRequestError(category, status));
      const outcome = requestEvaluation(resultId, false, { capability });
      await expect(outcome).rejects.toMatchObject({ category });
      if (status === undefined) await expect(outcome).rejects.not.toHaveProperty("status");
      else await expect(outcome).rejects.toHaveProperty("status", status);
      expect(transport).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the body-read error on a successful HTTP status", async () => {
    const { capability, transport } = controlledCapability();
    transport.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockRejectedValue(new Error("private")) });
    await expect(getInterviewResults({ capability })).rejects.toMatchObject({ category: "body-read-error", status: 200 });
  });

  it("rejects a late POST response after capability invalidation at transport settlement", async () => {
    const { capability, transport, invalidate } = controlledCapability();
    const response = deferred();
    transport.mockReturnValue(response.promise);
    const outcome = requestEvaluation(resultId, false, { capability });
    invalidate();
    response.resolve(jsonResponse(pending, { status: 202 }));
    await expect(outcome).rejects.toMatchObject({ category: "stale-session" });
    expect(transport).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "stale-session"])("discards a POST body that becomes %s while being read", async (category) => {
    const { capability, transport, invalidate } = controlledCapability();
    const controller = new AbortController();
    const started = deferred();
    const body = deferred();
    transport.mockResolvedValue({ ok: true, status: 202, text: () => {
      started.resolve();
      return body.promise;
    } });
    const outcome = requestEvaluation(resultId, false, { capability, signal: controller.signal });
    await started.promise;
    if (category === "cancelled") controller.abort();
    else invalidate();
    body.resolve(JSON.stringify(pending));
    await expect(outcome).rejects.toMatchObject({ category });
    expect(transport).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
