import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEvaluationStatus, getInterviewResult, getInterviewResults, requestEvaluation } from "./resultService.js";

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
