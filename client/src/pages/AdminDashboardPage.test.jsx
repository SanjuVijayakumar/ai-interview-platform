import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";

const api = "http://localhost:5000/api";
const token = "synthetic-dashboard-admin";
const firstUpdate = "2026-11-27T12:00:00.000Z";
const nextUpdate = "2026-11-27T13:00:00.000Z";
const admin = { id: "a".repeat(24), name: "Ada Lovelace", email: "ada@example.test", role: "admin" };
const replacement = { ...admin, id: "b".repeat(24), name: "Grace Hopper" };
const zeroAccounts = { regular: 0, administrators: 0, unknownRole: 0 };
const zeroEvaluations = { "not-requested": 0, pending: 0, completed: 0, failed: 0, unknown: 0 };

function stats({ empty = false, generatedAt = firstUpdate, questions = 8 } = {}) {
  return {
    generatedAt,
    timezone: "UTC",
    accounts: empty ? zeroAccounts : { regular: 8, administrators: 2, unknownRole: 1 },
    interviews: { total: empty ? 0 : 9 },
    questions: { total: empty ? 0 : questions },
    sessions: empty ? {
      total: 0, completed: 0, inProgress: 0, unknownStatus: 0, completionRatePercent: null,
    } : {
      total: 7, completed: 5, inProgress: 1, unknownStatus: 1, completionRatePercent: 83.3,
    },
    evaluations: empty ? {
      averageScore: null, scoredSessions: 0, status: zeroEvaluations,
    } : {
      averageScore: 0, scoredSessions: 1, status: { "not-requested": 1, pending: 1, completed: 1, failed: 1, unknown: 1 },
    },
    registrationTrend: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 29 + index)).toISOString().slice(0, 10),
      ...(!empty && index === 29 ? { regular: 3, administrators: 2, unknownRole: 1 } : zeroAccounts),
    })),
    interviewCategories: ["technical", "behavioral", "system-design", "other", "unknown"]
      .map((category, index) => ({ category, count: empty ? 0 : [4, 2, 1, 1, 1][index] })),
    recentActivity: empty ? [] : [
      "account-created", "interview-created", "question-saved", "session-started", "session-completed",
    ].map((type) => ({ type, occurredAt: firstUpdate })),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function response(options) {
  return json({ success: true, data: stats(options) });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

let respondToStats;
let requests;
let unexpected;

beforeEach(() => {
  localStorage.setItem("token", token);
  window.history.replaceState({}, "", "/admin/dashboard");
  respondToStats = () => response();
  requests = [];
  unexpected = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url === `${api}/health`) return json({ message: "Backend is available" });
    const bearer = new Headers(options?.headers).get("Authorization");
    const user = bearer === `Bearer ${token}` ? admin : replacement;
    if (url === `${api}/auth/profile`) return json({ success: true, user });
    if (url === `${api}/admin/me`) return json({ success: true, data: { userId: user.id, role: "admin" } });
    if (url === `${api}/admin/dashboard/stats`) {
      requests.push({ bearer, options });
      return respondToStats(requests.length, options);
    }
    unexpected.push(url);
    throw new Error("Unexpected request");
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  expect(unexpected).toEqual([]);
});

function assertMetric(label, value) {
  expect(screen.getByText(label, { selector: "dt", exact: true }).nextElementSibling).toHaveTextContent(value);
}

function refreshButton() {
  return screen.getByRole("button", { name: "Refresh" });
}

describe("admin dashboard with the production route and auth provider", () => {
  it("shows the loading skeleton and renders all sections from one authenticated GET", async () => {
    const pending = deferred();
    respondToStats = () => pending.promise;
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByText("Loading dashboard statistics")).toBeInTheDocument();
    expect(refreshButton()).toBeDisabled();
    expect(screen.queryByText("Total Users")).toBeNull();
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      bearer: `Bearer ${token}`,
      options: { method: "GET", redirect: "error", signal: expect.any(AbortSignal) },
    });
    await act(async () => pending.resolve(response()));

    expect(screen.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
    assertMetric("Total Users", "11");
    assertMetric("Total Interviews", "9");
    assertMetric("Total Questions", "8");
    assertMetric("Total Sessions", "7");
    assertMetric("Completed Sessions", "5");
    assertMetric("In-progress Sessions", "1");
    assertMetric("Completion Rate", "83.3%");
    assertMetric("Average Evaluation Score", "0 / 100");
    assertMetric("Regular users", "8");
    assertMetric("Administrators", "2");
    assertMetric("Unknown role", "1");
    expect(screen.getByText(/Last updated/).querySelector("time")).toHaveAttribute("datetime", firstUpdate);

    const trend = within(screen.getByRole("region", { name: "User Registration" }));
    expect(trend.getByTitle("Nov 27 UTC · Regular users: 3 · Administrators: 2 · Unknown role: 1")).toBeInTheDocument();
    fireEvent.click(trend.getByText("Daily registration counts"));
    const lastRow = within(trend.getByRole("row", { name: "Nov 27 3 2 1" }));
    expect(lastRow.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["3", "2", "1"]);

    const categories = within(screen.getByRole("region", { name: "Interview Categories" }));
    for (const [label, count] of [["Technical", 4], ["Behavioral", 2], ["System Design", 1], ["Other", 1], ["Unknown", 1]]) {
      expect(categories.getByText(label).nextElementSibling).toHaveTextContent(String(count));
    }
    const evaluation = within(screen.getByRole("region", { name: "Evaluation Overview" }));
    for (const status of ["Not Requested", "Pending", "Completed", "Failed", "Unknown"]) {
      expect(evaluation.getByText(status).nextElementSibling).toHaveTextContent("1");
    }
    const activity = within(screen.getByRole("region", { name: "Recent Activity" }));
    expect(activity.getByText(/Stored record milestones/)).toBeVisible();
    expect(activity.getAllByRole("listitem").map((item) => item.querySelector("time").dateTime))
      .toEqual(Array(5).fill(firstUpdate));
    for (const label of ["Account created", "Interview created", "Question saved", "Session started", "Session completed"]) {
      expect(activity.getByText(label)).toBeVisible();
    }
  });

  it("shows empty data and unavailable values without losing legitimate zero counts", async () => {
    respondToStats = () => response({ empty: true });
    render(<App />);
    expect(await screen.findByText(/No platform records yet/)).toBeVisible();
    expect(screen.getByText("No registrations in this period.")).toBeVisible();
    expect(screen.getByText("No interview categories to show.")).toBeVisible();
    expect(screen.getByText("No recent milestones.")).toBeVisible();
    assertMetric("Total Users", "0");
    assertMetric("Completion Rate", "N/A");
    assertMetric("Average Evaluation Score", "N/A");
  });

  it("shows a valid zero completion rate", async () => {
    const data = stats({ empty: true });
    data.sessions = { total: 1, completed: 0, inProgress: 1, unknownStatus: 0, completionRatePercent: 0 };
    respondToStats = () => json({ success: true, data });
    render(<App />);
    await screen.findByText("Completion Rate");
    assertMetric("Completion Rate", "0%");
  });

  it("refreshes once while pending and atomically updates the data and timestamp", async () => {
    const pending = deferred();
    respondToStats = (attempt) => attempt === 1 ? response() : pending.promise;
    render(<App />);
    await screen.findByText("Total Questions");
    const button = refreshButton();
    act(() => {
      button.click();
      button.click();
    });
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    assertMetric("Total Questions", "8");
    expect(requests).toHaveLength(2);
    await act(async () => pending.resolve(response({ generatedAt: nextUpdate, questions: 10 })));
    assertMetric("Total Questions", "10");
    expect(screen.getByText(/Last updated/).querySelector("time")).toHaveAttribute("datetime", nextUpdate);
    expect(refreshButton()).toBeEnabled();
    expect(requests).toHaveLength(2);
  });

  it("recovers from an initial failure with Retry", async () => {
    respondToStats = (attempt) => attempt === 1 ? json({ message: "private backend detail" }, 503) : response();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard statistics could not be loaded.");
    expect(screen.queryByText("private backend detail")).toBeNull();
    expect(screen.queryByText("Total Users")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Total Users")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("keeps the previous data and timestamp after a refresh fails", async () => {
    respondToStats = (attempt) => attempt === 1 ? response() : json({}, 500);
    render(<App />);
    await screen.findByText("Total Questions");
    fireEvent.click(refreshButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed. Showing previously loaded statistics.");
    assertMetric("Total Questions", "8");
    expect(screen.getByText(/Last updated/).querySelector("time")).toHaveAttribute("datetime", firstUpdate);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("aborts on navigation and cannot publish the abandoned response on return", async () => {
    const abandoned = deferred();
    respondToStats = (attempt) => attempt === 1 ? abandoned.promise : response({ questions: 10 });
    render(<App />);
    const nav = within(await screen.findByRole("navigation", { name: "Administrator navigation" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(nav.getByRole("link", { name: "Users" }));
    expect(requests[0].options.signal.aborted).toBe(true);
    fireEvent.click(nav.getByRole("link", { name: "Dashboard" }));
    await screen.findByText("Total Questions");
    await act(async () => abandoned.resolve(response({ questions: 99 })));
    assertMetric("Total Questions", "10");
    expect(requests).toHaveLength(2);
  });

  it("keeps an abandoned account response out of a replacement administrator's dashboard", async () => {
    const abandoned = deferred();
    respondToStats = (attempt) => attempt === 1 ? abandoned.promise : response({ questions: 10 });
    render(<App />);
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      localStorage.setItem("token", "synthetic-replacement-admin");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "token", oldValue: token, newValue: "synthetic-replacement-admin", storageArea: localStorage,
      }));
    });
    await screen.findByText("Total Questions");
    expect(screen.getByText(replacement.name)).toBeVisible();
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(requests[1].bearer).toBe("Bearer synthetic-replacement-admin");
    await act(async () => abandoned.resolve(response({ questions: 99 })));
    assertMetric("Total Questions", "10");
  });

  it.each([[401, "Sign in to PrepX"], [403, "Access Denied"]])(
    "lets the provider remove protected data after a refresh returns %i",
    async (status, heading) => {
      respondToStats = (attempt) => attempt === 1 ? response() : json({}, status);
      render(<App />);
      await screen.findByText("Total Questions");
      fireEvent.click(refreshButton());
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      expect(screen.queryByText("Total Questions")).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Administrator navigation" })).toBeNull();
      expect(requests).toHaveLength(2);
    },
  );
});
