import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EvaluationResultPage, { CapabilityBoundEvaluationResultPage } from "./EvaluationResultPage.jsx";
import { getEvaluationStatus, getInterviewResult, requestEvaluation } from "../services/resultService.js";
import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";

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

const tokenA = "synthetic-evaluation-token-a";
const tokenB = "synthetic-evaluation-token-b";
const userA = { id: "a".repeat(24), name: "Alice Test", email: "alice@example.test", role: "user" };
const userB = { id: "b".repeat(24), name: "Bob Test", email: "bob@example.test", role: "user" };
const resultB = { ...result, _id: "result-two", interview: { title: "Second result" } };
const statusPath = (id = result._id) => "/mock-sessions/" + id + "/evaluation";
const detailPath = (id = result._id) => "/results/" + id;
const notRequested = { success: true, status: "not-requested", attemptCount: 0 };
const pendingStatus = { success: true, status: "pending", attemptCount: 1 };
const failedStatus = { success: true, status: "failed", attemptCount: 1, retryAvailable: true };
const completedStatus = { success: true, status: "completed", attemptCount: 2, evaluation: {
  ...evaluation, _id: result._id, status: "completed", overallScore: 0,
} };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function AuthProbe({ report }) {
  const auth = useAuth();
  useEffect(() => { report(auth); }, [auth, report]);
  return null;
}

describe("capability-bound evaluation with real authentication and services", () => {
  let planned;
  let requests;

  beforeEach(async () => {
    const real = await vi.importActual("../services/resultService.js");
    getInterviewResult.mockReset().mockImplementation(real.getInterviewResult);
    getEvaluationStatus.mockReset().mockImplementation(real.getEvaluationStatus);
    requestEvaluation.mockReset().mockImplementation(real.requestEvaluation);
    localStorage.setItem("token", tokenA);
    planned = [];
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const headers = new Headers(options.headers);
      const next = planned[requests.length];
      requests.push({
        actual: {
          url: String(url), method: options.method ?? "GET",
          authorization: headers.get("Authorization"), contentType: headers.get("Content-Type"),
          body: options.body,
        },
        signal: options.signal,
      });
      if (!next) throw new Error("Unplanned evaluation request");
      if (next.response instanceof Error) throw next.response;
      return next.response;
    }));
  });

  afterEach(() => {
    try {
      expect(requests.map(({ actual }) => actual)).toEqual(planned.map(({ expected }) => expected));
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  function plan(path, response, { token = tokenA, retry } = {}) {
    const submitting = typeof retry === "boolean";
    planned.push({
      expected: {
        url: "http://localhost:5000/api" + path, method: submitting ? "POST" : "GET",
        authorization: "Bearer " + token, contentType: submitting ? "application/json" : null,
        body: submitting ? JSON.stringify({ retry }) : undefined,
      },
      response,
    });
  }

  function profile(user = userA, token = tokenA) {
    plan("/auth/profile", json({ success: true, user }), { token });
  }

  function planDetails({ record = result, state = notRequested, token = tokenA } = {}) {
    plan(detailPath(record._id), json({ success: true, result: record }), { token });
    plan(statusPath(record._id), json(state), { token });
  }

  function initial(options) {
    profile();
    planDetails(options);
  }

  async function mount({ strict = false } = {}) {
    let auth;
    const report = (value) => { auth = value; };
    const router = createMemoryRouter([
      {
        path: "/results/:resultId",
        element: <ProtectedSessionBoundary>
          {({ capability }) => <CapabilityBoundEvaluationResultPage capability={capability} />}
        </ProtectedSessionBoundary>,
      },
      { path: "/login", element: <p>Login route</p> },
    ], { initialEntries: [detailPath()] });
    const tree = <AuthProvider><AuthProbe report={report} /><RouterProvider router={router} /></AuthProvider>;
    let view;
    await act(async () => { view = render(strict ? <StrictMode>{tree}</StrictMode> : tree); });
    return { auth: () => auth, router, unmount: view.unmount };
  }

  async function click(name, twice = false) {
    const button = screen.getByRole("button", { name });
    await act(async () => {
      fireEvent.click(button);
      if (twice) fireEvent.click(button);
    });
  }

  async function tick(ms = 1400) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("submits once, polls pending after 1400 ms without overlap, and stops on completion", async () => {
    vi.useFakeTimers();
    initial();
    await mount();
    expect(screen.getByRole("heading", { name: result.interview.title })).toBeInTheDocument();
    const submission = deferred();
    plan(statusPath(), submission.promise, { retry: false });
    await click("Generate AI evaluation", true);
    expect(requests).toHaveLength(4);
    await act(async () => submission.resolve(json(pendingStatus, 202)));
    expect(screen.getByText("Evaluating answers...")).toBeInTheDocument();
    await tick(1399);
    expect(requests).toHaveLength(4);
    const firstPoll = deferred();
    plan(statusPath(), firstPoll.promise);
    await tick(1);
    await tick(4200);
    expect(requests).toHaveLength(5);
    await act(async () => firstPoll.resolve(json(pendingStatus)));
    plan(statusPath(), json(completedStatus));
    await tick();
    expect(screen.getByText("0", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("A clear and relevant answer.")).toBeInTheDocument();
    expect(screen.getByText("It maps keys to values.")).toBeInTheDocument();
    expect(screen.getByText("Practice concise explanations.")).toBeInTheDocument();
    await tick(4200);
    expect(requests).toHaveLength(6);
  });

  it("renders null scores distinctly and submits an eligible explicit retry once", async () => {
    initial({ state: failedStatus });
    await mount();
    const status = { ...completedStatus, evaluation: {
      ...completedStatus.evaluation, overallScore: null,
      answers: [{ ...evaluation.answers[0], answerScore: null }],
    } };
    plan(statusPath(), json(status), { retry: true });
    await click("Retry evaluation", true);
    expect(screen.getByText("Score unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
  });

  it.each([409, 502])("recovers HTTP %i with one guarded GET for persisted retry state", async (code) => {
    const retry = code === 409;
    initial({ state: retry ? failedStatus : notRequested });
    await mount();
    plan(statusPath(), json({ message: "Private error", retryAvailable: !retry }, code), { retry });
    plan(statusPath(), json(retry ? { ...failedStatus, attemptCount: 3, retryAvailable: false } : failedStatus));
    await click(retry ? "Retry evaluation" : "Generate AI evaluation");
    expect(screen.queryByText("Private error")).not.toBeInTheDocument();
    if (retry) {
      expect(screen.getByText("Retry limit reached for this result.")).toBeInTheDocument();
      expect(screen.getByText("Attempt 3")).toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: "Retry evaluation" })).toBeEnabled();
      expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    }
  });

  it.each(["failed read-back", "network", "body read"])("offers a read-only check after %s", async (outcome) => {
    initial();
    await mount();
    if (outcome === "failed read-back") {
      plan(statusPath(), json({}, 502), { retry: false });
      plan(statusPath(), json({}, 503));
    } else {
      const fetchError = new Error("Private transport error");
      const response = outcome === "network"
        ? fetchError : { status: 202, ok: true, text: async () => { throw fetchError; } };
      plan(statusPath(), response, { retry: false });
    }
    await click("Generate AI evaluation");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be confirmed/);
    expect(screen.queryByRole("button", { name: "Generate AI evaluation" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your answers are still saved/)).not.toBeInTheDocument();
    plan(statusPath(), json(completedStatus));
    await click("Check evaluation status", true);
    expect(screen.getByText("Performance summary")).toBeInTheDocument();
  });

  it.each([401, 403])("keeps provider ownership for submission HTTP %i", async (status) => {
    initial();
    const { auth, router } = await mount();
    plan(statusPath(), json({ message: "Private error" }, status), { retry: false });
    await click("Generate AI evaluation");
    if (status === 401) {
      expect(router.state.location.pathname).toBe("/login");
      expect(localStorage.getItem("token")).toBeNull();
    } else {
      expect(auth().session.status).toBe("authenticated");
      expect(screen.getByRole("alert")).toHaveTextContent("You do not have permission");
      expect(localStorage.getItem("token")).toBe(tokenA);
    }
  });

  it.each(["submission", "polling"])("aborts %s on logout and ignores late settlement", async (phase) => {
    vi.useFakeTimers();
    const polling = phase === "polling";
    initial({ state: polling ? pendingStatus : notRequested });
    const { auth, router } = await mount();
    const late = deferred();
    plan(statusPath(), late.promise, polling ? {} : { retry: false });
    if (polling) await tick();
    else await click("Generate AI evaluation");
    const signal = requests.at(-1).signal;
    await act(async () => auth().logout());
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(json(polling ? pendingStatus : {}, polling ? 200 : 502)));
    await tick(4200);
    expect(router.state.location.pathname).toBe("/login");
  });

  it.each(["replacement", "same-user relogin"])("discards recovery and stale 401 after %s", async (mode) => {
    initial();
    const { auth } = await mount();
    const late = deferred();
    plan(statusPath(), json({}, 502), { retry: false });
    plan(statusPath(), late.promise);
    await click("Generate AI evaluation");
    const signal = requests.at(-1).signal;
    const sameUser = mode === "same-user relogin";
    const token = sameUser ? tokenA : tokenB;
    profile(sameUser ? userA : userB, token);
    planDetails({ record: { ...result, interview: { title: "Fresh lifecycle" } }, token });
    await act(async () => {
      localStorage.setItem("token", token);
      await auth().completeLogin();
    });
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(json({}, 401)));
    expect(screen.getByRole("heading", { name: "Fresh lifecycle" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(auth().session.status).toBe("authenticated");
    expect(localStorage.getItem("token")).toBe(token);
  });

  it("clears an obsolete polling timer on replacement before it can dispatch", async () => {
    vi.useFakeTimers();
    initial({ state: pendingStatus });
    const { auth } = await mount();
    profile(userB, tokenB);
    planDetails({ token: tokenB });
    await act(async () => {
      localStorage.setItem("token", tokenB);
      await auth().completeLogin();
    });
    await tick(4200);
    expect(screen.getByRole("button", { name: "Generate AI evaluation" })).toBeEnabled();
  });

  it("never starts recovery for an old POST that settles after account replacement", async () => {
    initial();
    const { auth } = await mount();
    const old = deferred();
    plan(statusPath(), old.promise, { retry: false });
    await click("Generate AI evaluation");
    profile(userB, tokenB);
    planDetails({ token: tokenB });
    await act(async () => {
      localStorage.setItem("token", tokenB);
      await auth().completeLogin();
    });
    await act(async () => old.resolve(json({}, 502)));
    expect(screen.getByRole("button", { name: "Generate AI evaluation" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("pauses after a failed poll and resumes only after a status check confirms pending", async () => {
    vi.useFakeTimers();
    initial({ state: pendingStatus });
    await mount();
    plan(statusPath(), json({}, 503));
    await tick();
    expect(screen.getByRole("alert")).toHaveTextContent("Evaluation status could not be refreshed.");
    await tick(4200);
    plan(statusPath(), json(pendingStatus));
    await click("Check evaluation status", true);
    plan(statusPath(), json(completedStatus));
    await tick();
    expect(screen.getByText("Performance summary")).toBeInTheDocument();
  });

  it.each(["success", "failure", "poll"])("drops late %s from result A while result B has its own submission", async (outcome) => {
    vi.useFakeTimers();
    initial({ state: outcome === "poll" ? pendingStatus : notRequested });
    const { router } = await mount();
    const old = deferred();
    plan(statusPath(), old.promise, outcome === "poll" ? {} : { retry: false });
    if (outcome === "poll") await tick();
    else await click("Generate AI evaluation");
    const oldSignal = requests.at(-1).signal;
    planDetails({ record: resultB });
    await act(async () => router.navigate(detailPath(resultB._id)));
    expect(oldSignal.aborted).toBe(true);
    const next = deferred();
    plan(statusPath(resultB._id), next.promise, { retry: false });
    await click("Generate AI evaluation");
    const response = outcome === "success" ? json(pendingStatus, 202)
      : outcome === "failure" ? json({}, 502) : json(pendingStatus);
    await act(async () => old.resolve(response));
    await tick(4200);
    expect(screen.getByRole("heading", { name: "Second result" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starting evaluation..." })).toBeDisabled();
    await act(async () => next.resolve(json({ ...completedStatus, evaluation: { ...completedStatus.evaluation, _id: resultB._id } })));
    expect(screen.getByText("Performance summary")).toBeInTheDocument();
  });

  it("preserves pending status and polling during background revalidation", async () => {
    vi.useFakeTimers();
    initial({ state: pendingStatus });
    const { auth } = await mount();
    const verification = deferred();
    plan("/auth/profile", verification.promise);
    await act(async () => { void auth().verifySession(); });
    expect(auth().session.isRevalidating).toBe(true);
    expect(screen.getByText("Evaluating answers...")).toBeInTheDocument();
    plan(statusPath(), json(completedStatus));
    await tick();
    expect(screen.getByText("Performance summary")).toBeInTheDocument();
    await act(async () => verification.resolve(json({ success: true, user: userA })));
    expect(screen.getByText("Performance summary")).toBeInTheDocument();
  });

  it("survives StrictMode and clears the polling timer on unmount", async () => {
    vi.useFakeTimers();
    profile();
    initial({ state: pendingStatus });
    const { unmount } = await mount({ strict: true });
    expect(screen.getByText("Evaluating answers...")).toBeInTheDocument();
    await act(async () => unmount());
    expect(requests.at(-1).signal.aborted).toBe(true);
    await tick(4200);
  });
});
