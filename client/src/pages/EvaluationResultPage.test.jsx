import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EvaluationResultPage from "./EvaluationResultPage.jsx";
import { getEvaluationStatus, getInterviewResult, requestEvaluation } from "../services/resultService.js";

vi.mock("../services/resultService.js", () => ({
  getInterviewResults: vi.fn(),
  getInterviewResult: vi.fn(),
  getEvaluationStatus: vi.fn(),
  requestEvaluation: vi.fn(),
}));

const evaluation = {
  overallScore: 87,
  performanceRating: "strong",
  answeredCount: 1,
  unansweredCount: 0,
  overallFeedback: "A clear and relevant answer.",
  technicalKnowledgeAssessment: "Good technical foundation.",
  strongestAreas: ["Relevance"],
  weakestAreas: ["Clarity"],
  recommendedLearningTopics: ["Practice concise explanations."],
  answers: [{
    question: "question-one",
    questionText: "Explain a hash map.",
    category: "Technical",
    order: 1,
    answerText: "It maps keys to values.",
    answerScore: 87,
    dimensions: [{ key: "clarity", score: 80, rationale: "The explanation was concise." }],
    strengths: ["Direct explanation"],
    weaknesses: ["Could mention collisions"],
    missingConcepts: ["Collision handling"],
    improvementSuggestions: ["Include one practical example."],
    suggestedImprovedAnswer: "A hash map stores key and value pairs.",
  }],
};

const result = {
  _id: "result-one",
  status: "completed",
  totalQuestions: 1,
  interview: { title: "Backend Engineer" },
  answers: [{ questionText: "Explain a hash map.", answerText: "It maps keys to values." }],
};

function renderPage() {
  const router = createMemoryRouter([
    { path: "/results/:resultId", element: <EvaluationResultPage /> },
    { path: "/login", element: <p>Login route</p> },
    { path: "/results", element: <p>Results list route</p> },
  ], { initialEntries: ["/results/result-one"] });
  return { ...render(<RouterProvider router={router} />), router };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  getInterviewResult.mockResolvedValue(result);
  getEvaluationStatus.mockResolvedValue({ success: true, status: "completed", attemptCount: 1, evaluation });
});

afterEach(() => cleanup());

describe("EvaluationResultPage", () => {
  it("shows a loading state while persisted result and evaluation status load", async () => {
    const pendingResult = deferred();
    getInterviewResult.mockReturnValueOnce(pendingResult.promise);
    renderPage();
    expect(screen.getByRole("status", { name: "Loading evaluation result" })).toBeInTheDocument();
    await act(async () => { pendingResult.resolve(result); });
    expect(await screen.findByText("Performance summary")).toBeInTheDocument();
  });

  it("renders persisted summary, available criteria, and answer feedback", async () => {
    renderPage();
    expect(await screen.findByText("87", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("A clear and relevant answer.")).toBeInTheDocument();
    expect(screen.getAllByText("Clarity")).toHaveLength(2);
    expect(screen.getByText("The explanation was concise.")).toBeInTheDocument();
    expect(screen.getByText("Direct explanation")).toBeInTheDocument();
    expect(screen.getByText("View suggested answer")).toBeInTheDocument();
    expect(screen.queryByText(/evaluationModel|referenceAnswerUsed|referenceAnswerSnapshot/i)).not.toBeInTheDocument();
  });

  it("requests an initial evaluation with retry false and prevents duplicate submissions", async () => {
    const user = userEvent.setup();
    const request = deferred();
    getEvaluationStatus.mockResolvedValueOnce({ success: true, status: "not-requested", attemptCount: 0 });
    requestEvaluation.mockReturnValueOnce(request.promise);
    renderPage();
    const button = await screen.findByRole("button", { name: "Generate AI evaluation" });
    await user.click(button);
    expect(requestEvaluation).toHaveBeenCalledTimes(1);
    expect(requestEvaluation).toHaveBeenCalledWith("result-one", false);
    expect(screen.getByRole("button", { name: "Starting evaluation..." })).toBeDisabled();
    fireEvent.click(button);
    expect(requestEvaluation).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve({ success: true, status: "pending", attemptCount: 1 }); });
    expect(await screen.findByText("Evaluating answers...")).toBeInTheDocument();
  });

  it("shows and submits retry only when the backend says retryAvailable", async () => {
    const user = userEvent.setup();
    getEvaluationStatus.mockResolvedValueOnce({ success: true, status: "failed", attemptCount: 1, retryAvailable: true, message: "Evaluation failed." });
    requestEvaluation.mockResolvedValueOnce({ success: true, status: "completed", attemptCount: 2, evaluation });
    const firstRender = renderPage();
    await user.click(await screen.findByRole("button", { name: "Retry evaluation" }));
    expect(requestEvaluation).toHaveBeenCalledWith("result-one", true);
    expect(await screen.findByText("Performance summary")).toBeInTheDocument();
    firstRender.unmount();

    getEvaluationStatus.mockResolvedValueOnce({ success: true, status: "failed", attemptCount: 3, retryAvailable: false });
    renderPage();
    expect(await screen.findByText("Retry limit reached for this result.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry evaluation" })).not.toBeInTheDocument();
  });

  it("shows evaluation failures and handles unauthorized access", async () => {
    const user = userEvent.setup();
    getEvaluationStatus.mockResolvedValueOnce({ success: true, status: "not-requested", attemptCount: 0 });
    requestEvaluation.mockRejectedValueOnce(Object.assign(new Error("Evaluation service unavailable"), { status: 502, data: { status: "failed", attemptCount: 1, retryAvailable: true } }));
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Generate AI evaluation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Evaluation service unavailable");
    expect(await screen.findByRole("button", { name: "Retry evaluation" })).toBeInTheDocument();

    getInterviewResult.mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status: 401 }));
    renderPage();
    expect(await screen.findByText("Login route")).toBeInTheDocument();
  });

  it("renders partial evaluations without inventing missing assessment data and reloads persisted values", async () => {
    const partialResult = { ...result, answers: [] };
    const partialEvaluation = { status: "completed", attemptCount: 1, evaluation: { overallScore: null, overallFeedback: "Summary saved.", answers: [] } };
    getInterviewResult.mockResolvedValue(partialResult);
    getEvaluationStatus.mockResolvedValue(partialEvaluation);
    const { unmount } = renderPage();
    expect(await screen.findByText("Summary saved.")).toBeInTheDocument();
    expect(screen.getByText("No performance rating available")).toBeInTheDocument();
    expect(screen.getByText("Detailed question assessments are not available for this evaluation.")).toBeInTheDocument();
    unmount();

    renderPage();
    expect(await screen.findByText("Summary saved.")).toBeInTheDocument();
    expect(getInterviewResult).toHaveBeenCalledWith("result-one");
    expect(getEvaluationStatus).toHaveBeenCalledWith("result-one");
  });

  it("redirects to the login route when evaluation status retrieval is unauthorized", async () => {
    getEvaluationStatus.mockRejectedValueOnce(Object.assign(new Error("Authentication token has expired"), { status: 401 }));
    renderPage();
    expect(await screen.findByText("Login route")).toBeInTheDocument();
  });
});
