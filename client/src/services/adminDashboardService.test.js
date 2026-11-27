import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";
import { getAdminDashboardStats } from "./adminDashboardService.js";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";

const statsUrl = "http://localhost:5000/api/admin/dashboard/stats";
const generatedAt = "2026-11-27T12:00:00.000Z";
const counts = { regular: 0, administrators: 0, unknownRole: 0 };
const emptyStats = {
  generatedAt,
  timezone: "UTC",
  accounts: counts,
  interviews: { total: 0 },
  questions: { total: 0 },
  sessions: { total: 0, completed: 0, inProgress: 0, unknownStatus: 0, completionRatePercent: null },
  evaluations: {
    averageScore: null,
    scoredSessions: 0,
    status: { "not-requested": 0, pending: 0, completed: 0, failed: 0, unknown: 0 },
  },
  registrationTrend: Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 29 + index)).toISOString().slice(0, 10),
    ...counts,
  })),
  interviewCategories: ["technical", "behavioral", "system-design", "other", "unknown"]
    .map((category) => ({ category, count: 0 })),
  recentActivity: [],
};

const populatedStats = {
  ...emptyStats,
  accounts: { regular: 5, administrators: 2, unknownRole: 1 },
  interviews: { total: 2 },
  questions: { total: 8 },
  sessions: { total: 4, completed: 2, inProgress: 1, unknownStatus: 1, completionRatePercent: 66.7 },
  evaluations: {
    averageScore: 0,
    scoredSessions: 1,
    status: { ...emptyStats.evaluations.status, "not-requested": 1, completed: 1 },
  },
  interviewCategories: emptyStats.interviewCategories.map((bucket) =>
    bucket.category === "technical" ? { ...bucket, count: 2 } : bucket),
  recentActivity: [
    { type: "account-created", occurredAt: generatedAt },
    { type: "session-completed", occurredAt: generatedAt },
    { type: "session-started", occurredAt: "2026-10-29T00:00:00.000Z" },
  ],
};

const envelope = (data = populatedStats) => ({ success: true, data });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("admin dashboard statistics response", () => {
  let capability;
  let storage;

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
    storage = vi.spyOn(Storage.prototype, "getItem");
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });

  it.each([
    ["populated statistics with a zero evaluation score", populatedStats],
    ["empty platform statistics with null averages and rates", emptyStats],
    ["a zero completion rate", {
      ...emptyStats,
      sessions: { ...emptyStats.sessions, total: 1, inProgress: 1, completionRatePercent: 0 },
    }],
  ])("returns %s unchanged in one GET", async (_label, stats) => {
    capability.fetch.mockResolvedValue(json(envelope(stats)));
    const { signal } = new AbortController();

    await expect(getAdminDashboardStats({ capability, signal })).resolves.toEqual(stats);
    expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(statsUrl, { method: "GET", signal });
  });

  it("runs one request per call and uses each response", async () => {
    capability.fetch.mockResolvedValueOnce(json(envelope(emptyStats)))
      .mockResolvedValueOnce(json(envelope(populatedStats)));

    await expect(getAdminDashboardStats({ capability })).resolves.toEqual(emptyStats);
    await expect(getAdminDashboardStats({ capability })).resolves.toEqual(populatedStats);
    expect(capability.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unsuccessful envelope", (body) => { body.success = false; }],
    ["missing payload", (body) => { delete body.data; }],
    ["non-object payload", (body) => { body.data = []; }],
    ["unexpected envelope field", (body) => { body.token = "private"; }],
    ["invalid timestamp", ({ data }) => { data.generatedAt = "2026-02-30T12:00:00.000Z"; }],
    ["invalid timezone", ({ data }) => { data.timezone = "Asia/Kolkata"; }],
    ["missing account count", ({ data }) => { delete data.accounts.unknownRole; }],
    ["string count", ({ data }) => { data.accounts.regular = "0"; }],
    ["unsafe count", ({ data }) => { data.interviews.total = 9_007_199_254_740_992; }],
    ["negative count", ({ data }) => { data.questions.total = -1; }],
    ["fractional count", ({ data }) => { data.sessions.unknownStatus = 1.5; }],
    ["inconsistent session total", ({ data }) => { data.sessions.total = 0; }],
    ["wrong completion rate", ({ data }) => { data.sessions.completionRatePercent = 50; }],
    ["null completion rate for known statuses", ({ data }) => { data.sessions.completionRatePercent = null; }],
    ["score above 100", ({ data }) => { data.evaluations.averageScore = 101; }],
    ["missing average for scored sessions", ({ data }) => { data.evaluations.averageScore = null; }],
    ["invalid scored count", ({ data }) => { data.evaluations.scoredSessions = 2; }],
    ["inconsistent evaluation distribution", ({ data }) => { data.evaluations.status.pending = 1; }],
    ["incomplete trend", ({ data }) => { data.registrationTrend.pop(); }],
    ["reversed trend", ({ data }) => { data.registrationTrend.reverse(); }],
    ["duplicate trend date", ({ data }) => { data.registrationTrend[1].date = data.registrationTrend[0].date; }],
    ["missing trend count", ({ data }) => { delete data.registrationTrend[0].regular; }],
    ["raw category", ({ data }) => { data.interviewCategories[0].category = "private"; }],
    ["duplicate category", ({ data }) => { data.interviewCategories[1].category = "technical"; }],
    ["inconsistent category total", ({ data }) => { data.interviewCategories[0].count = 1; }],
    ["too many milestones", ({ data }) => { data.recentActivity = Array(11).fill(data.recentActivity[0]); }],
    ["unsupported milestone", ({ data }) => { data.recentActivity[0].type = "login"; }],
    ["milestone with a private ID", ({ data }) => { data.recentActivity[0].id = "private"; }],
    ["future milestone", ({ data }) => { data.recentActivity[0].occurredAt = "2026-11-28T00:00:00.000Z"; }],
    ["expired milestone", ({ data }) => { data.recentActivity[2].occurredAt = "2026-10-28T23:59:59.999Z"; }],
    ["incorrect milestone order", ({ data }) => { data.recentActivity.reverse(); }],
    ["incorrect milestone tie order", ({ data }) => {
      [data.recentActivity[0], data.recentActivity[1]] = [data.recentActivity[1], data.recentActivity[0]];
    }],
  ])("rejects a malformed success response with %s", async (_label, change) => {
    const body = structuredClone(envelope());
    change(body);
    capability.fetch.mockResolvedValue(json(body));

    const error = await getAdminDashboardStats({ capability }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AuthenticatedRequestError);
    expect(error).toMatchObject({ category: "malformed-response", status: 200 });
    expect(error).not.toHaveProperty("data");
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", "private unparseable body"],
    ["non-finite JSON number", JSON.stringify(envelope()).replace('"averageScore":0', '"averageScore":1e309')],
  ])("rejects %s", async (_label, body) => {
    capability.fetch.mockResolvedValue(new Response(body, { status: 200 }));
    await expect(getAdminDashboardStats({ capability })).rejects.toMatchObject({ category: "malformed-response" });
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexpected successful HTTP status", async () => {
    capability.fetch.mockResolvedValue(json(envelope(), 201));
    await expect(getAdminDashboardStats({ capability })).rejects.toMatchObject({
      category: "malformed-response", status: 201,
    });
  });

  it("fails closed without an explicit usable capability", async () => {
    for (const options of [undefined, null, {}, { capability: null }, Object.create({ capability })]) {
      await expect(getAdminDashboardStats(options)).rejects.toMatchObject({ category: "missing-capability" });
    }
    const request = vi.fn();
    await expect(getAdminDashboardStats({ capability: { fetch: request } }))
      .rejects.toMatchObject({ category: "invalid-capability" });
    capability.isCurrent.mockImplementation(() => { throw new Error("private"); });
    await expect(getAdminDashboardStats({ capability }))
      .rejects.toMatchObject({ category: "invalid-capability" });
    expect(request).not.toHaveBeenCalled();
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("cancels before dispatch and while consuming a response", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(getAdminDashboardStats({ capability, signal: cancelled.signal }))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(capability.fetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    capability.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        controller.abort();
        return JSON.stringify(envelope());
      },
    });
    await expect(getAdminDashboardStats({ capability, signal: controller.signal }))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(statsUrl, { method: "GET", signal: controller.signal });
  });

  it("discards data if the capability becomes stale during a response", async () => {
    capability.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        capability.isCurrent.mockReturnValue(false);
        return JSON.stringify(envelope());
      },
    });
    await expect(getAdminDashboardStats({ capability })).rejects.toMatchObject({ category: "stale-session" });
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([500, 503])("propagates a safe HTTP %i error without retrying", async (status) => {
    capability.fetch.mockResolvedValue(json({ success: false, message: "private" }, status));
    const error = await getAdminDashboardStats({ capability }).catch((caught) => caught);
    expect(error).toMatchObject({ category: "http-error", status, message: "The authenticated request failed." });
    expect(error).not.toHaveProperty("data");
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates a safe network failure without retrying", async () => {
    capability.fetch.mockRejectedValue(Object.assign(new Error("private"), { category: "network-error" }));
    const error = await getAdminDashboardStats({ capability }).catch((caught) => caught);
    expect(error).toMatchObject({ category: "network-error" });
    expect(error.message).not.toContain("private");
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("admin dashboard statistics with AuthProvider", () => {
  function Provider({ children }) {
    return createElement(AuthProvider, null, children);
  }

  async function verifyAdmin(status = 200) {
    const user = { id: "507f1f77bcf86cd799439011", name: "Ada", email: "ada@example.test", role: "admin" };
    localStorage.setItem("token", "synthetic-admin-session");
    fetch.mockImplementation(async (url) => {
      if (url === "http://localhost:5000/api/auth/profile") return json({ success: true, user });
      if (url === "http://localhost:5000/api/admin/me") {
        return json({ success: true, data: { userId: user.id, role: "admin" } });
      }
      if (url === statsUrl) return json(status === 200 ? envelope() : { message: "private" }, status);
      throw new Error("Unexpected request");
    });

    const { result } = renderHook(useAuth, { wrapper: Provider });
    await waitFor(() => expect(result.current.session.status).toBe("authenticated"));
    await act(async () => { await result.current.verifyAdmin(); });
    const capability = result.current.captureAuthenticatedRequest({ administrator: true });
    expect(capability?.isCurrent()).toBe(true);
    fetch.mockClear();
    return { result, capability };
  }

  it("uses the admin capability and rejects a personal capability at the destination guard", async () => {
    const { result, capability } = await verifyAdmin();
    const personal = result.current.captureAuthenticatedRequest();
    await expect(getAdminDashboardStats({ capability: personal }))
      .rejects.toMatchObject({ category: "invalid-destination" });
    expect(fetch).not.toHaveBeenCalled();

    const { signal } = new AbortController();
    await expect(getAdminDashboardStats({ capability, signal })).resolves.toEqual(populatedStats);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(statsUrl, expect.objectContaining({
      method: "GET", signal, redirect: "error",
    }));
  });

  it.each([
    [401, "unauthorized", "unauthenticated"],
    [403, "forbidden", "authenticated"],
  ])("preserves provider-managed HTTP %i invalidation and blocks reuse", async (status, category, sessionStatus) => {
    const { result, capability } = await verifyAdmin(status);
    await act(async () => {
      const error = await getAdminDashboardStats({ capability }).catch((caught) => caught);
      expect(error).toMatchObject({ category, status });
      expect(error.message).not.toContain("private");
    });
    expect(result.current.session.status).toBe(sessionStatus);
    if (status === 403) expect(result.current.administrator.status).toBe("denied");
    await expect(getAdminDashboardStats({ capability })).rejects.toMatchObject({ category: "stale-session" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
