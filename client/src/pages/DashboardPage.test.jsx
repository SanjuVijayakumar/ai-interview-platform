import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import DashboardPage from "./DashboardPage.jsx";
import { logoutUser } from "../services/authService.js";
import { getDashboardStats } from "../services/dashboardService.js";
import { getInterviews } from "../services/interviewService.js";

vi.mock("../services/authService.js", () => ({ logoutUser: vi.fn() }));
vi.mock("../services/dashboardService.js", () => ({ getDashboardStats: vi.fn() }));
vi.mock("../services/interviewService.js", () => ({ getInterviews: vi.fn() }));

const defaultStats = {
  totalInterviews: 4,
  completedInterviews: 2,
  pendingInterviews: 2,
  averageScore: 87.6,
};

function renderDashboard() {
  const router = createMemoryRouter([
    { path: "/dashboard", element: <DashboardPage /> },
    { path: "/login", element: <p>Login route</p> },
    { path: "/interviews", element: <p>Interviews route</p> },
  ], { initialEntries: ["/dashboard"] });
  return { ...render(<RouterProvider router={router} />), router };
}

function cardValue(label) {
  return within(screen.getByText(label).closest("article")).getByText(/^(?:\d+(?:\.\d+)?|—|…)$/);
}

function makeInterview(id, title, createdAt, status = "scheduled") {
  return {
    _id: id,
    title,
    category: "Engineering",
    difficulty: "Intermediate",
    createdAt,
    status,
  };
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

beforeEach(() => {
  getDashboardStats.mockResolvedValue(defaultStats);
  getInterviews.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("DashboardPage", () => {
  it("renders backend statistics and preserves recent-interview sorting", async () => {
    getDashboardStats.mockResolvedValue({
      totalInterviews: 8,
      completedInterviews: 2,
      pendingInterviews: 6,
      averageScore: 87.56,
    });
    getInterviews.mockResolvedValue([
      makeInterview("older", "Older session", "2026-10-01T10:00:00.000Z", "completed"),
      makeInterview("newest", "Newest session", "2026-11-01T10:00:00.000Z", "scheduled"),
      makeInterview("middle", "Middle session", "2026-10-15T10:00:00.000Z", "in-progress"),
    ]);

    renderDashboard();

    expect(await screen.findByText("Newest session")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("8");
    expect(cardValue("Completed interviews")).toHaveTextContent("2");
    expect(cardValue("Pending interviews")).toHaveTextContent("6");
    expect(cardValue("Average score")).toHaveTextContent("87.6");

    const recentTitles = screen.getByRole("heading", { name: "Recent interviews" })
      .closest("section")
      .querySelectorAll("article h3");
    expect([...recentTitles].map((heading) => heading.textContent)).toEqual([
      "Newest session", "Middle session", "Older session",
    ]);
  });

  it.each([
    { averageScore: null, display: "—" },
    { averageScore: 0, display: "0" },
  ])("formats average score $averageScore as $display", async ({ averageScore, display }) => {
    getDashboardStats.mockResolvedValue({ ...defaultStats, averageScore });
    renderDashboard();

    expect(await screen.findByText(display, { selector: "p" })).toBeInTheDocument();
    expect(cardValue("Average score")).toHaveTextContent(display);
  });

  it("shows statistics loading independently while recent interviews load", async () => {
    const pendingStats = deferred();
    getDashboardStats.mockReturnValue(pendingStats.promise);
    getInterviews.mockResolvedValue([
      makeInterview("recent", "Available recent interview", "2026-11-01T10:00:00.000Z"),
    ]);
    renderDashboard();

    expect(await screen.findByText("Available recent interview")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("…");
    expect(within(screen.getByText("Total interviews").closest("article")).getByText("Loading your statistics")).toBeInTheDocument();
    pendingStats.resolve(defaultStats);
    await waitFor(() => expect(cardValue("Total interviews")).toHaveTextContent("4"));
  });

  it("shows a statistics error without hiding recent interviews and retries only statistics", async () => {
    const user = userEvent.setup();
    getDashboardStats
      .mockRejectedValueOnce(new Error("Statistics unavailable"))
      .mockResolvedValueOnce(defaultStats);
    getInterviews.mockResolvedValue([
      makeInterview("recent", "Recent interview remains visible", "2026-11-01T10:00:00.000Z"),
    ]);
    renderDashboard();

    expect(await screen.findByText("Statistics unavailable")).toBeInTheDocument();
    expect(screen.getByText("Recent interview remains visible")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("—");
    await user.click(screen.getByRole("button", { name: "Retry statistics" }));

    await waitFor(() => expect(cardValue("Total interviews")).toHaveTextContent("4"));
    expect(getDashboardStats).toHaveBeenCalledTimes(2);
    expect(getInterviews).toHaveBeenCalledTimes(1);
  });

  it("shows a recent-interviews error without hiding statistics and retries only interviews", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockRejectedValueOnce(new Error("Interview history unavailable"))
      .mockResolvedValueOnce([
        makeInterview("recent", "Interview history recovered", "2026-11-01T10:00:00.000Z"),
      ]);
    renderDashboard();

    expect(await screen.findByText("Interview history unavailable")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("4");
    await user.click(screen.getByRole("button", { name: "Reload interviews" }));

    expect(await screen.findByText("Interview history recovered")).toBeInTheDocument();
    expect(getInterviews).toHaveBeenCalledTimes(2);
    expect(getDashboardStats).toHaveBeenCalledTimes(1);
  });

  it("redirects to login and logs out when either request is unauthorized", async () => {
    getDashboardStats.mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status: 401 }));
    renderDashboard();

    expect(await screen.findByText("Login route")).toBeInTheDocument();
    expect(logoutUser).toHaveBeenCalledTimes(1);
  });
});
