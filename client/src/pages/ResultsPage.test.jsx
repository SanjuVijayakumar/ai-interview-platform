import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResultsPage from "./ResultsPage.jsx";
import { getInterviewResults } from "../services/resultService.js";

vi.mock("../services/resultService.js", () => ({ getInterviewResults: vi.fn() }));

function renderResults() {
  const router = createMemoryRouter([
    { path: "/results", element: <ResultsPage /> },
    { path: "/results/:resultId", element: <p>Evaluation result route</p> },
    { path: "/mock-session/:sessionId", element: <p>Resume session route</p> },
    { path: "/login", element: <p>Login route</p> },
  ], { initialEntries: ["/results"] });
  return { ...render(<RouterProvider router={router} />), router };
}

beforeEach(() => {
  getInterviewResults.mockResolvedValue([
    { _id: "completed-id", status: "completed", evaluationStatus: "completed", overallScore: 91, totalQuestions: 4, interview: { title: "Frontend Engineer" }, completedAt: "2026-10-10T10:00:00.000Z" },
    { _id: "active-id", status: "in-progress", totalQuestions: 3, interview: { title: "Platform Engineer" } },
  ]);
});

afterEach(() => cleanup());

describe("ResultsPage", () => {
  it("loads persisted result history with links to evaluation and resume routes", async () => {
    renderResults();
    expect(await screen.findByRole("heading", { name: "Interview Results" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Frontend Engineer/ })).toHaveAttribute("href", "/results/completed-id");
    expect(screen.getByRole("link", { name: /Platform Engineer/ })).toHaveAttribute("href", "/mock-session/active-id");
    expect(screen.getByText("Evaluation ready")).toBeInTheDocument();
    expect(screen.getByText("91")).toBeInTheDocument();
  });

  it("shows a useful empty state", async () => {
    getInterviewResults.mockResolvedValueOnce([]);
    renderResults();
    expect(await screen.findByText("No interview results yet")).toBeInTheDocument();
  });

  it("redirects to login on unauthorized result history", async () => {
    getInterviewResults.mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status: 401 }));
    renderResults();
    expect(await screen.findByText("Login route")).toBeInTheDocument();
  });
});
