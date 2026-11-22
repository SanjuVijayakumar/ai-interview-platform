import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDashboardStats } from "./dashboardService.js";

function textResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(data) };
}

beforeEach(() => {
  window.localStorage.setItem("token", "dashboard-test-token");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("dashboardService", () => {
  it("requests authenticated dashboard statistics and returns the response contract", async () => {
    const stats = {
      totalInterviews: 4,
      completedInterviews: 2,
      pendingInterviews: 2,
      averageScore: 0,
    };
    fetch.mockResolvedValue(textResponse(stats));

    await expect(getDashboardStats()).resolves.toEqual(stats);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/api/dashboard/stats",
      { headers: { Authorization: "Bearer dashboard-test-token" } },
    );
  });

  it("reports missing authentication as unauthorized without making a request", async () => {
    window.localStorage.removeItem("token");

    await expect(getDashboardStats()).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves unauthorized API errors for the page to handle", async () => {
    fetch.mockResolvedValue(textResponse(
      { success: false, message: "Authentication token has expired." },
      { ok: false, status: 401 },
    ));

    await expect(getDashboardStats()).rejects.toMatchObject({
      status: 401,
      message: "Authentication token has expired.",
    });
  });

  it("rejects malformed statistics instead of fabricating values", async () => {
    fetch.mockResolvedValue(textResponse({
      totalInterviews: 1,
      completedInterviews: 0,
      pendingInterviews: 1,
      averageScore: "0",
    }));

    await expect(getDashboardStats()).rejects.toThrow("response was not in the expected format");
  });
});
