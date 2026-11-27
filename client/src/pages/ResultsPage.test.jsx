import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResultsPage, { CapabilityBoundResultsPage } from "./ResultsPage.jsx";
import { getInterviewResults } from "../services/resultService.js";
import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider } from "../contexts/AuthContext.jsx";

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

describe("capability-bound result history", () => {
  const token = "synthetic-history-token";
  const api = "http://localhost:5000/api";

  beforeEach(async () => {
    const real = await vi.importActual("../services/resultService.js");
    getInterviewResults.mockReset().mockImplementation(real.getInterviewResults);
    localStorage.setItem("token", token);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function response(body, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  function planHistory(history) {
    const user = { id: "a".repeat(24), name: "History Test", email: "history@example.test", role: "user" };
    return vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ success: true, user }))
      .mockImplementationOnce(() => history));
  }

  async function mount() {
    const router = createMemoryRouter([
      { path: "/results", element: <ProtectedSessionBoundary>
        {({ capability }) => <CapabilityBoundResultsPage capability={capability} />}
      </ProtectedSessionBoundary> },
      { path: "/login", element: <p>Login route</p> },
    ], { initialEntries: ["/results"] });
    let view;
    await act(async () => { view = render(<AuthProvider><RouterProvider router={router} /></AuthProvider>); });
    return view;
  }

  function assertHistoryCall(index = 2) {
    expect(fetch).toHaveBeenNthCalledWith(index, api + "/results", expect.objectContaining({
      method: "GET", headers: new Headers({ Authorization: "Bearer " + token }), signal: expect.any(AbortSignal),
    }));
  }

  it("loads history using the provider's bearer and displays zero but no null score", async () => {
    let resolve;
    planHistory(new Promise((settle) => { resolve = settle; }));
    await mount();
    assertHistoryCall();
    expect(screen.getByRole("status", { name: "Loading interview results" })).toBeInTheDocument();
    await act(async () => resolve(response({ success: true, results: [
      { _id: "zero", status: "completed", answers: [], overallScore: 0, interview: { title: "Zero score" } },
      { _id: "active", status: "in-progress", answers: [], overallScore: null, interview: { title: "In progress" } },
    ] })));
    expect(screen.getByRole("link", { name: /Zero score/ })).toHaveTextContent("0 / 100");
    expect(screen.getByRole("link", { name: /In progress/ })).not.toHaveTextContent("/ 100");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the session after resource 403 and retries the history GET with the same bearer", async () => {
    planHistory(response({ message: "Private error" }, 403));
    await mount();
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have permission");
    expect(localStorage.getItem("token")).toBe(token);
    fetch.mockResolvedValueOnce(response({ success: true, results: [] }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    assertHistoryCall(3);
    expect(screen.getByText("No interview results yet")).toBeInTheDocument();
  });
});
