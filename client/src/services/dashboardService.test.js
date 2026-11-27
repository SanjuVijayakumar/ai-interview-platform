import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";
import { getDashboardStats } from "./dashboardService.js";

const statsUrl = "http://localhost:5000/api/dashboard/stats";
const emptyStats = {
  totalInterviews: 0,
  completedInterviews: 0,
  pendingInterviews: 0,
  averageScore: null,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("uses legacy authentication when capability is inherited, preserving zero counts and a null score", async () => {
    fetch.mockResolvedValue(textResponse(emptyStats));

    await expect(getDashboardStats(Object.create({ capability: null }))).resolves.toEqual(emptyStats);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(statsUrl, {
      headers: { Authorization: "Bearer dashboard-test-token" },
    });
  });

  it("preserves the legacy non-401 HTTP error payload", async () => {
    const data = { success: false, message: "Failed to retrieve dashboard statistics" };
    fetch.mockResolvedValue(textResponse(data, { ok: false, status: 500 }));
    await expect(getDashboardStats()).rejects.toMatchObject({ status: 500, message: data.message, data });
  });

  it("preserves the legacy transport error message", async () => {
    fetch.mockRejectedValue(new TypeError("Synthetic transport failure"));
    await expect(getDashboardStats()).rejects.toThrow(
      "Could not connect to PrepX. Check that the backend is running and try again.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("dashboardService capability-bound requests", () => {
  let capability;
  let storage;
  let logout;

  beforeEach(() => {
    capability = { isCurrent: vi.fn(() => true), fetch: vi.fn() };
    storage = ["getItem", "setItem", "removeItem", "clear"].map((method) => vi.spyOn(Storage.prototype, method));
    logout = vi.fn();
    window.addEventListener("prepx:logout", logout);
  });

  afterEach(() => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      for (const spy of storage) expect(spy).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
    } finally {
      for (const spy of storage) spy.mockRestore();
      window.removeEventListener("prepx:logout", logout);
    }
  });

  it.each([emptyStats, { ...emptyStats, totalInterviews: 2, completedInterviews: 2, averageScore: 87.56 }])(
    "returns the flat statistics without changing values ($averageScore)",
    async (stats) => {
      const { signal } = new AbortController();
      capability.fetch.mockResolvedValue(textResponse(stats));

      await expect(getDashboardStats({ capability, signal })).resolves.toEqual(stats);
      expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(statsUrl, { method: "GET", signal });
    },
  );

  it.each([
    [null, "missing-capability"],
    [undefined, "missing-capability"],
    [{ fetch: vi.fn() }, "invalid-capability"],
  ])("rejects an unusable explicit capability (%s)", async (unusable, category) => {
    await expect(getDashboardStats({ capability: unusable })).rejects.toMatchObject({ category });
    expect(unusable?.fetch ?? capability.fetch).not.toHaveBeenCalled();
  });

  it("blocks stale capabilities and pre-cancelled requests before dispatch", async () => {
    capability.isCurrent.mockReturnValue(false);
    await expect(getDashboardStats({ capability })).rejects.toMatchObject({ category: "stale-session" });
    capability.isCurrent.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort();
    await expect(getDashboardStats({ capability, signal: controller.signal })).rejects.toMatchObject({ category: "cancelled" });
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("rejects a response that arrives after the capability becomes stale", async () => {
    const response = deferred();
    capability.fetch.mockReturnValue(response.promise);
    const pending = getDashboardStats({ capability });
    const reading = vi.fn();
    capability.isCurrent.mockReturnValue(false);
    response.resolve({ ok: true, status: 200, text: reading });

    await expect(pending).rejects.toMatchObject({ category: "stale-session" });
    expect(reading).not.toHaveBeenCalled();
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale success", "stale-session"],
    ["stale rejection", "stale-session"],
    ["cancelled read", "cancelled"],
    ["current read rejection", "body-read-error"],
  ])("preserves the utility error for %s", async (scenario, category) => {
    const controller = new AbortController();
    const started = deferred();
    const body = deferred();
    const text = vi.fn(() => {
      started.resolve();
      return body.promise;
    });
    capability.fetch.mockResolvedValue({ ok: true, status: 200, text });
    const rejected = getDashboardStats({ capability, signal: controller.signal }).catch((error) => error);
    await started.promise;
    if (scenario.startsWith("stale")) capability.isCurrent.mockReturnValue(false);
    if (scenario === "cancelled read") controller.abort();
    if (scenario.endsWith("rejection")) body.reject(new Error("synthetic private detail"));
    else body.resolve(JSON.stringify(emptyStats));

    const error = await rejected;
    expect(error).toBeInstanceOf(AuthenticatedRequestError);
    expect(error.category).toBe(category);
    expect(error.status).toBe(category === "body-read-error" ? 200 : undefined);
    expect(error).not.toHaveProperty("data");
    expect(error.message).not.toContain("synthetic private detail");
    expect(text).toHaveBeenCalledTimes(1);
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([["unauthorized", 401], ["forbidden", 403], ["network-error", undefined]])(
    "preserves the provider's %s error",
    async (category, status) => {
      capability.fetch.mockImplementation(async () => {
        if (status) capability.isCurrent.mockReturnValue(false);
        throw Object.assign(new Error("synthetic private detail"), { category, status });
      });
      const error = await getDashboardStats({ capability }).catch((caught) => caught);

      expect(error).toBeInstanceOf(AuthenticatedRequestError);
      expect(error.category).toBe(category);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("synthetic private detail");
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([403, 404, 500, 503])("preserves safe HTTP %i errors without exposing backend data", async (status) => {
    capability.fetch.mockResolvedValue(textResponse(
      { success: false, message: "synthetic private detail" },
      { ok: false, status },
    ));
    const pending = getDashboardStats({ capability });

    await expect(pending).rejects.toMatchObject({
      category: "http-error",
      status,
      message: "The authenticated request failed.",
    });
    await expect(pending).rejects.not.toHaveProperty("data");
    expect(capability.isCurrent()).toBe(true);
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", "unparseable"],
    ["missing fields", JSON.stringify({ totalInterviews: 1 })],
    ["unexpected envelope", JSON.stringify({ stats: emptyStats })],
    ["invalid score", JSON.stringify({ ...emptyStats, averageScore: "0" })],
  ])("rejects %s on a successful response", async (_label, body) => {
    capability.fetch.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue(body) });
    const pending = getDashboardStats({ capability });

    await expect(pending).rejects.toBeInstanceOf(AuthenticatedRequestError);
    await expect(pending).rejects.toMatchObject({ category: "malformed-response", status: 200 });
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });
});
