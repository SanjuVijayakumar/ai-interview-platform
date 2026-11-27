import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InterviewDetailsPage, { CapabilityBoundInterviewDetailsPage, CapabilityBoundMockInterviewControls } from "./InterviewDetailsPage.jsx";
import { createQuestion, deleteQuestion, generateInterviewQuestions, getQuestions, updateQuestion } from "../services/questionService.js";
import { getInterviewById } from "../services/interviewService.js";
import { createMockSession, findInProgressMockSession } from "../services/mockSessionService.js";

import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";

vi.mock("../services/questionService.js", () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  generateInterviewQuestions: vi.fn(),
  getQuestions: vi.fn(),
  updateQuestion: vi.fn(),
}));

vi.mock("../services/interviewService.js", () => ({
  getInterviewById: vi.fn(),
}));

vi.mock("../services/mockSessionService.js", () => ({
  createMockSession: vi.fn(),
  findInProgressMockSession: vi.fn(),
}));

const interview = {
  _id: "interview-1",
  title: "Frontend Engineer",
  category: "Technical",
  difficulty: "Intermediate",
  status: "active",
  practiceStatus: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const generatedQuestions = [
  {
    questionText: "How do you declare a block-scoped variable in JavaScript?",
    category: "JavaScript",
    difficulty: "Beginner",
    expectedAnswer: "Use let or const to declare a variable scoped to its enclosing block.",
  },
  {
    questionText: "What is the difference between let and const?",
    category: "JavaScript",
    difficulty: "Beginner",
    expectedAnswer: "Both are block-scoped, but const prevents reassignment after initialization.",
  },
  {
    questionText: "How can you check whether a value is an array?",
    category: "JavaScript",
    difficulty: "Beginner",
    expectedAnswer: "Use Array.isArray(value), which reliably distinguishes arrays from other objects.",
  },
];

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function renderPage(interviewRecord = interview) {
  const router = createMemoryRouter([
    { path: "/interviews/:interviewId", element: <InterviewDetailsPage /> },
    { path: "/mock-session/:sessionId", element: <p>Mock session opened</p> },
    { path: "/login", element: <p>Login route</p> },
  ], { initialEntries: ["/interviews/interview-1"] });
  getInterviewById.mockResolvedValue(interviewRecord);
  return { ...render(<RouterProvider router={router} />), router };
}

async function showGeneratedPreview(user, questions = generatedQuestions) {
  generateInterviewQuestions.mockResolvedValueOnce(questions);
  const countInput = await screen.findByLabelText(/Number of Questions/);
  await user.clear(countInput);
  await user.type(countInput, String(questions.length));
  await user.click(screen.getByRole("button", { name: "Generate Questions with AI" }));
  await screen.findByRole("heading", { name: questions[0].questionText });
}

async function selectQuestions(user, indexes) {
  for (const index of indexes) {
    await user.click(screen.getByRole("checkbox", { name: `Select generated question ${index + 1}` }));
  }
}

beforeEach(() => {
  getInterviewById.mockResolvedValue(interview);
  getQuestions.mockResolvedValue([]);
  findInProgressMockSession.mockReset().mockResolvedValue(null);
  createMockSession.mockReset().mockResolvedValue({ _id: "new-session", status: "in-progress" });
  generateInterviewQuestions.mockResolvedValue(generatedQuestions);
});

afterEach(() => cleanup());

describe("capability-bound mock interview controls", () => {
  let capability;
  const missingSession = {
    status: 404,
    category: "http-error",
    data: { errorCode: "no_in_progress_session" },
  };

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
  });

  async function renderControls(origin = capability) {
    const router = createMemoryRouter([
      {
        path: "/interviews/:interviewId",
        element: <CapabilityBoundMockInterviewControls capability={origin} hasQuestions />,
      },
      { path: "/mock-session/:sessionId", element: <p>Mock session opened</p> },
    ], { initialEntries: ["/interviews/interview-1"] });
    await act(async () => { render(<RouterProvider router={router} />); });
    return router;
  }

  function start() {
    fireEvent.click(screen.getByRole("button", { name: "Start Mock Interview" }));
  }

  it("binds lookup and creation while keeping legacy interview and question operations isolated", async () => {
    findInProgressMockSession.mockRejectedValue(missingSession);
    const creation = deferred();
    createMockSession.mockReturnValueOnce(creation.promise);
    const router = await renderControls();
    expect(findInProgressMockSession).toHaveBeenCalledExactlyOnceWith("interview-1", { capability });
    expect(getInterviewById).not.toHaveBeenCalled();
    expect(getQuestions).not.toHaveBeenCalled();
    await act(async () => { start(); });
    expect(screen.getByRole("button", { name: "Opening..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Opening..." }));
    expect(findInProgressMockSession).toHaveBeenCalledTimes(2);
    expect(findInProgressMockSession).toHaveBeenLastCalledWith("interview-1", { capability });
    expect(createMockSession).toHaveBeenCalledExactlyOnceWith("interview-1", { capability });
    await act(async () => { creation.resolve({ _id: "new-session", status: "in-progress" }); });
    expect(router.state.location.pathname).toBe("/mock-session/new-session");
    expect(router.state.location.state).toEqual({ interviewId: "interview-1" });
  });

  it("resumes an existing session through the originating capability", async () => {
    findInProgressMockSession.mockResolvedValue({ _id: "existing", status: "in-progress" });
    const router = await renderControls();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume Mock Interview" }));
    });
    expect(findInProgressMockSession.mock.calls).toEqual([
      ["interview-1", { capability }],
      ["interview-1", { capability }],
    ]);
    expect(createMockSession).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/mock-session/existing");
  });

  it.each([
    ["generic 404", "http-error", 404],
    ["cancelled", "cancelled", undefined],
    ["stale", "stale-session", undefined],
    ["network error", "network-error", undefined],
    ["unauthorized", "unauthorized", 401],
    ["forbidden", "forbidden", 403],
  ])("does not create or navigate after %s", async (message, category, status) => {
    const router = await renderControls();
    findInProgressMockSession.mockRejectedValueOnce(Object.assign(new Error(message), { category, status }));
    await act(async () => { start(); });
    expect(createMockSession).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/interviews/interview-1");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it.each(["lookup", "creation"])("discards a %s response after invalidation", async (operation) => {
    const pending = deferred();
    const router = await renderControls();
    if (operation === "lookup") {
      findInProgressMockSession.mockReturnValueOnce(pending.promise);
    } else {
      findInProgressMockSession.mockRejectedValueOnce(missingSession);
      createMockSession.mockReturnValueOnce(pending.promise);
    }
    await act(async () => { start(); });
    capability.isCurrent.mockReturnValue(false);
    await act(async () => { pending.resolve({ _id: "old-session", status: "in-progress" }); });
    expect(createMockSession).toHaveBeenCalledTimes(operation === "creation" ? 1 : 0);
    expect(router.state.location.pathname).toBe("/interviews/interview-1");
  });

  it("does not create after a missing-session response from an earlier route", async () => {
    const pending = deferred();
    const router = await renderControls();
    findInProgressMockSession.mockImplementationOnce(async () => {
      await pending.promise;
      throw missingSession;
    });
    await act(async () => { start(); });
    await act(async () => { await router.navigate("/interviews/interview-2"); });
    await act(async () => { pending.resolve(); });
    expect(createMockSession).not.toHaveBeenCalled();
    expect(findInProgressMockSession).toHaveBeenLastCalledWith("interview-2", { capability });
    expect(router.state.location.pathname).toBe("/interviews/interview-2");
  });

  it("fails closed with no capability", async () => {
    await renderControls(null);
    expect(findInProgressMockSession).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer current/);
  });

  it("requires normalized 404 metadata before creating a session", async () => {
    const router = await renderControls();
    await act(async () => { start(); });
    expect(createMockSession).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/interviews/interview-1");
  });
});

describe("InterviewDetailsPage AI question generation", () => {
  it("displays backend practice status rather than the stored manual status", async () => {
    renderPage({ ...interview, status: "active", practiceStatus: "completed" });

    expect(await screen.findByLabelText("Practice status: Completed")).toHaveClass("theme-status-success");
    expect(screen.queryByLabelText("Practice status: In Progress")).not.toBeInTheDocument();
  });

  it.each([
    { practiceStatus: undefined, storedStatus: "completed" },
    { practiceStatus: "unknown", storedStatus: "in-progress" },
  ])("does not display stored status when practiceStatus is unavailable", async ({ practiceStatus, storedStatus }) => {
    const interviewRecord = { ...interview, status: storedStatus };
    if (practiceStatus !== undefined) interviewRecord.practiceStatus = practiceStatus;
    else delete interviewRecord.practiceStatus;
    renderPage(interviewRecord);

    expect(await screen.findByLabelText("Practice status: Practice status unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Practice status: Completed")).not.toBeInTheDocument();
  });

  it("starts a mock session without changing the existing start flow", async () => {
    const user = userEvent.setup();
    getQuestions.mockResolvedValue([{ _id: "question-1", questionText: "Question", order: 1 }]);
    findInProgressMockSession.mockResolvedValue(null);
    createMockSession.mockResolvedValue({ _id: "new-session", status: "in-progress" });
    const { router } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Start Mock Interview" }));

    expect(await screen.findByText("Mock session opened")).toBeInTheDocument();
    expect(createMockSession).toHaveBeenCalledWith("interview-1");
    expect(router.state.location.pathname).toBe("/mock-session/new-session");
  });

  it("resumes the existing in-progress mock session without creating another", async () => {
    const user = userEvent.setup();
    findInProgressMockSession.mockResolvedValue({ _id: "existing-session", status: "in-progress" });
    const { router } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Resume Mock Interview" }));

    expect(await screen.findByText("Mock session opened")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/mock-session/existing-session");
    expect(createMockSession).not.toHaveBeenCalled();
  });

  it("generates a preview with selected preferences and supports bulk and individual selection without saving", async () => {
    const user = userEvent.setup();
    const generation = deferred();
    generateInterviewQuestions.mockReturnValueOnce(generation.promise);
    renderPage();

    const countInput = await screen.findByLabelText(/Number of Questions/);
    await user.clear(countInput);
    await user.type(countInput, "3");
    await user.selectOptions(screen.getByLabelText(/Difficulty/), "Beginner");
    await user.selectOptions(screen.getByLabelText(/Question Category/), "Custom");
    await user.type(screen.getByPlaceholderText("Enter a category (up to 60 characters)"), "JavaScript");
    await user.click(screen.getByRole("button", { name: "Generate Questions with AI" }));

    expect(await screen.findByText("Generating a tailored question set...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generating..." })).toBeDisabled();
    expect(generateInterviewQuestions).toHaveBeenCalledWith("interview-1", {
      count: 3,
      difficulty: "Beginner",
      category: "JavaScript",
    });

    await act(async () => { generation.resolve(generatedQuestions); });

    const previewCards = await screen.findAllByRole("article");
    expect(previewCards).toHaveLength(3);
    for (const [index, question] of generatedQuestions.entries()) {
      expect(within(previewCards[index]).getByRole("heading", { name: question.questionText })).toBeInTheDocument();
      expect(within(previewCards[index]).getByText("JavaScript")).toBeInTheDocument();
      expect(within(previewCards[index]).getByText("Beginner")).toBeInTheDocument();
      expect(within(previewCards[index]).getByText(question.expectedAnswer)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("checkbox", { name: /^Select generated question/ })).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^Select generated question/ }).every((checkbox) => checkbox.checked)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^Select generated question/ }).every((checkbox) => !checkbox.checked)).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: "Select generated question 2" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select generated question 2" })).toBeChecked();
    expect(createQuestion).not.toHaveBeenCalled();
    expect(getQuestions).toHaveBeenCalledTimes(1);
  });

  it("shows a generation error and restores the generate button", async () => {
    const user = userEvent.setup();
    generateInterviewQuestions.mockRejectedValueOnce(new Error("Generation unavailable."));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Generate Questions with AI" }));

    await waitFor(() => expect(generateInterviewQuestions).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Generation unavailable.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate Questions with AI" })).toBeEnabled());
    expect(createQuestion).not.toHaveBeenCalled();
  });

  it("saves only selected questions, marks them saved, and refreshes the question list", async () => {
    const user = userEvent.setup();
    const savedQuestions = [];
    getQuestions.mockImplementation(async () => savedQuestions);
    createQuestion.mockImplementation(async (question) => {
      const saved = { ...question, _id: `saved-${savedQuestions.length + 1}` };
      savedQuestions.push(saved);
      return saved;
    });
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0, 1]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (2)" }));

    await screen.findByText("All selected questions saved successfully.");
    expect(createQuestion).toHaveBeenCalledTimes(2);
    expect(createQuestion.mock.calls.map(([question]) => question.questionText)).toEqual([
      generatedQuestions[0].questionText,
      generatedQuestions[1].questionText,
    ]);
    expect(screen.getByRole("checkbox", { name: "Select generated question 3" })).not.toBeChecked();
    for (const index of [0, 1]) {
      expect(within(screen.getAllByRole("article").find((article) =>
        within(article).queryByRole("heading", { name: generatedQuestions[index].questionText })
      )).getByText("Saved")).toBeInTheDocument();
    }
    expect(within(screen.getByRole("region", { name: "Question Management" }))
      .getByText(generatedQuestions[0].questionText)).toBeInTheDocument();
    expect(getQuestions).toHaveBeenCalledTimes(3);
  });

  it("assigns orders after the highest existing order and saves sequentially", async () => {
    const user = userEvent.setup();
    const existingQuestion = {
      _id: "existing-5",
      questionText: "Existing question",
      category: "JavaScript",
      difficulty: "Beginner",
      expectedAnswer: "Existing answer",
      order: 5,
    };
    getQuestions.mockResolvedValue([existingQuestion]);
    const firstSave = deferred();
    createQuestion
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ _id: "saved-7" });
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0, 1]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (2)" }));
    await waitFor(() => expect(createQuestion).toHaveBeenCalledTimes(1));
    expect(createQuestion.mock.calls[0][0].order).toBe(6);

    await act(async () => {
      firstSave.resolve({ _id: "saved-6" });
      await firstSave.promise;
    });
    await waitFor(() => expect(createQuestion).toHaveBeenCalledTimes(2));
    expect(createQuestion.mock.calls[1][0].order).toBe(7);
    expect(createQuestion.mock.calls.map(([question]) => question.order)).toEqual([6, 7]);
  });

  it("blocks rapid duplicate submits and prevents resubmitting questions already saved", async () => {
    const saved = deferred();
    createQuestion.mockReturnValue(saved.promise);
    renderPage();
    const user = userEvent.setup();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0]);

    const saveButton = screen.getByRole("button", { name: "Save Selected Questions (1)" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    await waitFor(() => expect(createQuestion).toHaveBeenCalledTimes(1));

    await act(async () => {
      saved.resolve({ _id: "saved-1" });
      await saved.promise;
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select generated question 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Selected Questions (0)" })).toBeDisabled();
    expect(createQuestion).toHaveBeenCalledTimes(1);
  });

  it("continues after an individual save failure and retries only the failed question", async () => {
    const user = userEvent.setup();
    const savedQuestions = [];
    getQuestions.mockImplementation(async () => [...savedQuestions]);
    createQuestion.mockImplementation(async (question) => {
      if (question.questionText === generatedQuestions[1].questionText && savedQuestions.length === 1) {
        throw Object.assign(new Error("Temporary save failure."), { status: 500 });
      }
      const saved = { ...question, _id: `saved-${savedQuestions.length + 1}` };
      savedQuestions.push(saved);
      return saved;
    });
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0, 1, 2]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (3)" }));

    expect(await screen.findByText(/2 saved; 1 could not be saved/)).toBeInTheDocument();
    expect(createQuestion.mock.calls.map(([question]) => question.questionText)).toEqual([
      generatedQuestions[0].questionText,
      generatedQuestions[1].questionText,
      generatedQuestions[2].questionText,
    ]);
    const previewCards = screen.getAllByRole("article").filter((article) =>
      generatedQuestions.some((question) => within(article).queryByRole("heading", { name: question.questionText }))
    );
    expect(within(previewCards[0]).getByText("Saved")).toBeInTheDocument();
    expect(within(previewCards[1]).getByText(/^Save failed:/)).toHaveTextContent("Temporary save failure.");
    expect(within(previewCards[2]).getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select generated question 2" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (1)" }));

    await screen.findByText("All selected questions saved successfully.");
    expect(createQuestion.mock.calls.map(([question]) => question.questionText)).toEqual([
      generatedQuestions[0].questionText,
      generatedQuestions[1].questionText,
      generatedQuestions[2].questionText,
      generatedQuestions[1].questionText,
    ]);
  });

  it("uses read-back verification when a save response is lost", async () => {
    const user = userEvent.setup();
    const savedQuestions = [];
    getQuestions.mockImplementation(async () => [...savedQuestions]);
    createQuestion.mockImplementationOnce(async (question) => {
      savedQuestions.push({ ...question, _id: "saved-before-response-loss" });
      throw new Error("Response lost after save.");
    });
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (1)" }));

    await screen.findByText("All selected questions saved successfully.");
    expect(createQuestion).toHaveBeenCalledTimes(1);
    expect(getQuestions).toHaveBeenCalledTimes(4);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not submit later questions when read-back leaves persistence status uncertain", async () => {
    const user = userEvent.setup();
    getQuestions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Read-back unavailable."))
      .mockRejectedValueOnce(new Error("Refresh unavailable."));
    createQuestion.mockRejectedValueOnce(new Error("Save response lost."));
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0, 1, 2]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (3)" }));

    expect(await screen.findByText(/0 saved; 3 could not be saved/)).toBeInTheDocument();
    expect(createQuestion).toHaveBeenCalledTimes(1);
    expect(within(screen.getAllByRole("article").find((article) =>
      within(article).queryByRole("heading", { name: generatedQuestions[1].questionText })
    )).getByText(/held to avoid an order conflict/)).toBeInTheDocument();
  });

  it("stops further saves and redirects to login after an unauthorized response", async () => {
    const user = userEvent.setup();
    const savedQuestions = [];
    getQuestions.mockImplementation(async () => [...savedQuestions]);
    createQuestion
      .mockImplementationOnce(async (question) => {
        savedQuestions.push({ ...question, _id: "saved-1" });
        return { _id: "saved-1" };
      })
      .mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status: 401 }));
    renderPage();
    await showGeneratedPreview(user);
    await selectQuestions(user, [0, 1, 2]);

    await user.click(screen.getByRole("button", { name: "Save Selected Questions (3)" }));

    expect(await screen.findByText("Login route")).toBeInTheDocument();
    expect(createQuestion).toHaveBeenCalledTimes(2);
    expect(createQuestion.mock.calls.map(([question]) => question.questionText)).toEqual([
      generatedQuestions[0].questionText,
      generatedQuestions[1].questionText,
    ]);
  });
});

const tokenA = "synthetic-details-token-a";
const tokenB = "synthetic-details-token-b";
const userA = { id: "a".repeat(24), name: "Alice Test", email: "alice@example.test", role: "user" };
const userB = { id: "b".repeat(24), name: "Bob Test", email: "bob@example.test", role: "user" };
const interviewB = { ...interview, _id: "interview-2", title: "Second interview" };
const profilePath = "/auth/profile";
const interviewPath = (id = interview._id) => `/interviews/${id}`;
const questionsPath = (id = interview._id) => `/questions/${id}`;
const mockPath = (id = interview._id) => interviewPath(id) + "/sessions/in-progress";
const generationPath = interviewPath() + "/generate-questions";
const preferences = { count: 3, difficulty: "Beginner", category: "JavaScript" };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function identity(user = userA) {
  return response({ success: true, user });
}

function questionList(...questions) {
  return response({ success: true, questions });
}

function missingMockSession() {
  return response({ success: false, message: "No in-progress session found" }, 404);
}

function questionPayload(index, order) {
  const { questionText, category, difficulty, expectedAnswer } = generatedQuestions[index];
  return { interview: interview._id, questionText, category, difficulty, expectedAnswer, order };
}

function persistedQuestion(index, order) {
  return { ...questionPayload(index, order), _id: "question-" + index };
}

function savedQuestion(question) {
  return response({ success: true, question }, 201);
}

function AuthProbe({ report }) {
  const auth = useAuth();
  useEffect(() => { report(auth); }, [auth, report]);
  return null;
}

describe("capability-bound interview details with real authentication and services", () => {
  let plans;
  let calls;

  beforeEach(async () => {
    const [questions, interviews, mockSessions] = await Promise.all([
      vi.importActual("../services/questionService.js"),
      vi.importActual("../services/interviewService.js"),
      vi.importActual("../services/mockSessionService.js"),
    ]);
    for (const mock of [createQuestion, deleteQuestion, generateInterviewQuestions, getQuestions, updateQuestion]) {
      mock.mockReset();
    }
    createQuestion.mockImplementation(questions.createQuestion);
    deleteQuestion.mockImplementation(questions.deleteQuestion);
    generateInterviewQuestions.mockImplementation(questions.generateInterviewQuestions);
    getQuestions.mockImplementation(questions.getQuestions);
    updateQuestion.mockImplementation(questions.updateQuestion);
    getInterviewById.mockReset().mockImplementation(interviews.getInterviewById);
    createMockSession.mockImplementation(mockSessions.createMockSession);
    findInProgressMockSession.mockImplementation(mockSessions.findInProgressMockSession);

    localStorage.setItem("token", tokenA);
    plans = [];
    calls = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const actual = {
        url: String(url),
        method: options.method ?? "GET",
        authorization: new Headers(options.headers).get("Authorization"),
        payload: options.body ? JSON.parse(options.body) : undefined,
      };
      const next = plans[calls.length];
      calls.push({ actual, signal: options.signal });
      if (!next) throw new Error("Unplanned test request");
      return next.response;
    }));
  });

  afterEach(() => {
    try {
      expect(calls.map(({ actual }) => actual)).toEqual(plans.map(({ expected }) => expected));
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      localStorage.clear();
    }
  });

  function plan(path, result, { method = "GET", token = tokenA, payload } = {}) {
    plans.push({
      expected: { url: "http://localhost:5000/api" + path, method, authorization: "Bearer " + token, payload },
      response: result,
    });
  }

  function planDetails({ record = interview, questions = questionList(), mock = missingMockSession(), token = tokenA } = {}) {
    plan(interviewPath(record._id), response({ success: true, interview: record }), { token });
    plan(questionsPath(record._id), questions, { token });
    plan(mockPath(record._id), mock, { token });
  }

  function planInitial(options) {
    plan(profilePath, identity());
    planDetails(options);
  }

  async function mount({ strict = false } = {}) {
    let auth;
    const report = (value) => { auth = value; };
    const router = createMemoryRouter([
      {
        path: "/interviews/:interviewId",
        element: (
          <ProtectedSessionBoundary>
            {({ capability }) => <CapabilityBoundInterviewDetailsPage capability={capability} />}
          </ProtectedSessionBoundary>
        ),
      },
      { path: "/login", element: <p>Login route</p> },
      { path: "/mock-session/:sessionId", element: <p>Mock session opened</p> },
    ], { initialEntries: [interviewPath()] });
    const tree = <AuthProvider><AuthProbe report={report} /><RouterProvider router={router} /></AuthProvider>;
    let view;
    await act(async () => { view = render(strict ? <StrictMode>{tree}</StrictMode> : tree); });
    return { auth: () => auth, router, unmount: view.unmount };
  }

  function change(label, value) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  function click(name) {
    fireEvent.click(screen.getByRole("button", { name: (label) => label === name }));
  }

  async function generate(result = response({ success: true, questions: generatedQuestions })) {
    plan(generationPath, result, { method: "POST", payload: preferences });
    change(/Number of Questions/, "3");
    change(/^Difficulty/, "Beginner");
    change(/Question Category/, "Custom");
    change("Custom question category", " JavaScript ");
    await act(async () => click("Generate Questions with AI"));
  }

  async function selectAll() {
    await generate();
    click("Select all");
  }

  function planWrite(index, order, result = savedQuestion(persistedQuestion(index, order))) {
    plan("/questions", result, { method: "POST", payload: questionPayload(index, order) });
  }

  it("loads details and binds manual create, update, delete, and each refresh to one credential", async () => {
    planInitial();
    await mount();
    expect(screen.getByText(interview.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Mock Interview", exact: true })).toBeDisabled();
    const question = persistedQuestion(0, 7);
    const pending = deferred();
    planWrite(0, 7, pending.promise);
    click("Add Question");
    change("Question Text", question.questionText);
    change("Category", question.category);
    change("Order", "7");
    change(/Expected Answer/, question.expectedAnswer);
    const form = screen.getByRole("dialog").querySelector("form");
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(calls).toHaveLength(5);
    plan(questionsPath(), questionList(question));
    await act(async () => pending.resolve(savedQuestion(question)));
    expect(screen.getByText("Question created successfully.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Mock Interview", exact: true })).toBeEnabled();

    const updated = { ...question, questionText: "Updated question" };
    const { questionText, category, difficulty, order, expectedAnswer } = updated;
    plan("/questions/" + question._id, savedQuestion(updated), { method: "PATCH", payload: { questionText, category, difficulty, order, expectedAnswer } });
    plan(questionsPath(), questionList(updated));
    click("Edit");
    change("Question Text", questionText);
    await act(async () => click("Save changes"));
    expect(screen.getByText("Question updated successfully.")).toBeInTheDocument();

    plan("/questions/" + question._id, response({ success: true, questionId: question._id }), { method: "DELETE" });
    plan(questionsPath(), response({}, 503));
    await act(async () => click("Delete"));
    expect(screen.getByText("Question deleted successfully.")).toBeInTheDocument();
    expect(screen.getByText("Question was deleted, but the list could not be refreshed.")).toBeInTheDocument();
    plan(questionsPath(), questionList());
    await act(async () => click("Reload questions"));
    expect(screen.getByText("No questions added yet")).toBeInTheDocument();
  });

  it("recovers an uncertain manual write with a read only", async () => {
    planInitial({ questions: questionList(persistedQuestion(0, 1)) });
    await mount();
    plan("/questions/question-0", response({}, 503), { method: "DELETE" });
    plan(questionsPath(), questionList());
    await act(async () => click("Delete"));
    expect(screen.getByText(/change could not be confirmed/)).toBeInTheDocument();
    expect(screen.queryByText("Question deleted successfully.")).not.toBeInTheDocument();
  });

  it("generates a preview, saves sequentially above the highest order, and retries only a rejected item", async () => {
    const existing = { ...persistedQuestion(0, 9), questionText: "Previously saved" };
    planInitial({ questions: questionList(existing) });
    await mount();
    await selectAll();
    click("Deselect all");
    await selectQuestions(userEvent.setup(), [0, 2]);
    click("Clear selection");
    click("Select all");
    expect(calls).toHaveLength(5);
    plan(questionsPath(), questionList(existing));
    const pending = deferred();
    planWrite(0, 10, pending.promise);
    const save = screen.getByRole("button", { name: "Save Selected Questions (3)" });
    await act(async () => { fireEvent.click(save); fireEvent.click(save); });
    expect(calls).toHaveLength(7);
    const first = persistedQuestion(0, 10);
    const third = persistedQuestion(2, 11);
    planWrite(1, 11, response({ message: "Private backend text" }, 400));
    planWrite(2, 11);
    plan(questionsPath(), questionList(existing, first, third));
    await act(async () => pending.resolve(savedQuestion(first)));
    expect(screen.getByText(/2 saved; 1 could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select generated question 2" })).toBeChecked();
    expect(screen.queryByText(/Private backend text/)).not.toBeInTheDocument();

    plan(questionsPath(), questionList(existing, first, third));
    planWrite(1, 12);
    plan(questionsPath(), questionList(existing, first, third, persistedQuestion(1, 12)));
    await act(async () => click("Save Selected Questions (1)"));
    expect(screen.getByText("All selected questions saved successfully.")).toBeInTheDocument();
  });

  it.each(["confirmed", "absent", "read failed"])("handles an ambiguous save when read-back is %s", async (outcome) => {
    planInitial();
    await mount();
    await selectAll();
    plan(questionsPath(), questionList());
    planWrite(0, 1, response({}, 503));
    const first = persistedQuestion(0, 1);
    if (outcome === "confirmed") {
      plan(questionsPath(), questionList(first));
      planWrite(1, 2);
      planWrite(2, 3);
      plan(questionsPath(), questionList(first, persistedQuestion(1, 2), persistedQuestion(2, 3)));
    } else {
      plan(questionsPath(), outcome === "absent" ? questionList() : response({}, 503));
      plan(questionsPath(), questionList());
    }
    await act(async () => click("Save Selected Questions (3)"));
    if (outcome === "confirmed") {
      expect(screen.getByText("All selected questions saved successfully.")).toBeInTheDocument();
    } else {
      expect(screen.getByText(/0 saved; 3 could not be saved/)).toBeInTheDocument();
      expect(screen.getAllByText(/held to avoid an order conflict/)).toHaveLength(2);
      expect(screen.queryByText("Saved", { exact: true })).not.toBeInTheDocument();
    }
  });

  it.each([400, 403, 404, 429, 502, 503, 504])("uses local generation feedback on HTTP %i and preserves authentication", async (status) => {
    planInitial();
    const { auth } = await mount();
    await generate(response({ message: "Private backend text" }, status));
    const expected = {
      400: "Check question generation preferences.", 403: "Permission denied for this operation.",
      404: "Interview unavailable.", 429: "AI service rate limit reached.",
      502: "AI question generation could not be completed.", 503: "AI question service temporarily unavailable.",
      504: "AI question request timed out.",
    };
    expect(screen.getByRole("alert")).toHaveTextContent(expected[status]);
    expect(auth().session.status).toBe("authenticated");
    expect(localStorage.getItem("token")).toBe(tokenA);
  });

  it.each(["logout", "401", "replacement", "same-user relogin"])("ends bulk saves on %s without a continuation using another token", async (termination) => {
    planInitial();
    const { auth, router } = await mount();
    await selectAll();
    plan(questionsPath(), questionList());
    const pending = deferred();
    planWrite(0, 1, pending.promise);
    await act(async () => click("Save Selected Questions (3)"));
    const signal = calls.at(-1).signal;
    if (termination === "logout") await act(async () => auth().logout());
    if (termination === "replacement" || termination === "same-user relogin") {
      const sameUser = termination === "same-user relogin";
      const token = sameUser ? tokenA : tokenB;
      plan(profilePath, identity(sameUser ? userA : userB), { token });
      planDetails({ token });
      await act(async () => {
        localStorage.setItem("token", token);
        await auth().completeLogin();
      });
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    }
    await act(async () => pending.resolve(response({}, termination === "401" || termination === "replacement" ? 401 : 503)));
    expect(signal.aborted).toBe(true);
    if (termination === "logout" || termination === "401") {
      expect(router.state.location.pathname).toBe("/login");
      expect(localStorage.getItem("token")).toBeNull();
    } else {
      expect(router.state.location.pathname).toBe(interviewPath());
      expect(auth().session.status).toBe("authenticated");
    }
  });

  it("ends bulk saving on a current unauthorized read-back", async () => {
    planInitial();
    const { router } = await mount();
    await selectAll();
    plan(questionsPath(), questionList());
    planWrite(0, 1, response({}, 503));
    plan(questionsPath(), response({}, 401));
    await act(async () => click("Save Selected Questions (3)"));
    expect(router.state.location.pathname).toBe("/login");
  });

  it.each(["generation", "mutation", "read-back", "refresh"])("drops late %s from interview A after opening interview B", async (phase) => {
    planInitial();
    const { router } = await mount();
    const pending = deferred();
    if (phase === "generation") {
      await generate(pending.promise);
    } else {
      await selectAll();
      plan(questionsPath(), questionList());
      planWrite(0, 1, phase === "mutation" ? pending.promise : phase === "read-back" ? response({}, 503) : undefined);
      if (phase === "read-back") plan(questionsPath(), pending.promise);
      if (phase === "refresh") {
        planWrite(1, 2);
        planWrite(2, 3);
        plan(questionsPath(), pending.promise);
      }
      await act(async () => click("Save Selected Questions (3)"));
    }
    const signal = calls.at(-1).signal;
    planDetails({ record: interviewB });
    await act(async () => router.navigate(interviewPath(interviewB._id)));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(phase === "generation"
      ? response({ success: true, questions: generatedQuestions })
      : phase === "mutation" ? savedQuestion(persistedQuestion(0, 1)) : questionList(persistedQuestion(0, 1))));
    expect(screen.getByText(interviewB.title)).toBeInTheDocument();
    expect(screen.queryByText(generatedQuestions[0].questionText)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aborts generation on logout", async () => {
    planInitial();
    const { auth, router } = await mount();
    const pending = deferred();
    await generate(pending.promise);
    const signal = calls.at(-1).signal;
    await act(async () => auth().logout());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response({ success: true, questions: generatedQuestions })));
    expect(router.state.location.pathname).toBe("/login");
  });

  it("keeps a preview, unsaved form, and pending generation during background verification", async () => {
    planInitial();
    const { auth } = await mount();
    await selectAll();
    const generation = deferred();
    await generate(generation.promise);
    click("Add Question");
    change("Question Text", "Unsaved draft");
    const verification = deferred();
    plan(profilePath, verification.promise);
    await act(async () => { void auth().verifySession(); });
    expect(auth().session.isRevalidating).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Select generated question 1" })).toBeChecked();
    expect(screen.getByLabelText("Question Text")).toHaveValue("Unsaved draft");
    await act(async () => verification.resolve(identity()));
    expect(auth().session.isRevalidating).toBe(false);
    await act(async () => generation.resolve(response({ success: true, questions: generatedQuestions })));
    expect(screen.getByRole("heading", { name: generatedQuestions[0].questionText })).toBeInTheDocument();
    expect(screen.getByLabelText("Question Text")).toHaveValue("Unsaved draft");
  });

  it.each(["start", "resume", "generic 404"])("preserves mock interview %s behavior", async (action) => {
    const session = { _id: "session-1", status: "in-progress" };
    const hasSession = action === "resume";
    planInitial({
      questions: questionList(persistedQuestion(0, 1)),
      mock: hasSession ? response({ session }) : missingMockSession(),
    });
    const { router } = await mount();
    plan(mockPath(), hasSession ? response({ session }) : action === "start" ? missingMockSession() : response({}, 404));
    if (action === "start") plan(interviewPath() + "/sessions", response({ session }, 201), { method: "POST" });
    await act(async () => click(hasSession ? "Resume Mock Interview" : "Start Mock Interview"));
    expect(router.state.location.pathname).toBe(action === "generic 404" ? interviewPath() : "/mock-session/session-1");
  });

  it("keeps a newer refresh when the initial list arrives late", async () => {
    const initial = deferred();
    planInitial({ questions: initial.promise });
    await mount();
    const question = persistedQuestion(0, 7);
    planWrite(0, 7);
    plan(questionsPath(), questionList(question));
    click("Add Question");
    change("Question Text", question.questionText);
    change("Category", question.category);
    change("Order", "7");
    change(/Expected Answer/, question.expectedAnswer);
    await act(async () => fireEvent.submit(screen.getByRole("dialog").querySelector("form")));
    await act(async () => initial.resolve(questionList()));
    expect(screen.getByRole("heading", { name: question.questionText })).toBeInTheDocument();
  });

  it("survives StrictMode setup replay and aborts pending generation on unmount", async () => {
    plan(profilePath, identity());
    plan(profilePath, identity());
    plan(interviewPath(), response({ success: true, interview }));
    plan(questionsPath(), questionList());
    planDetails();
    plan(mockPath(), missingMockSession());
    const { unmount } = await mount({ strict: true });
    const pending = deferred();
    await generate(pending.promise);
    const signal = calls.at(-1).signal;
    await act(async () => unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response({}, 401)));
    expect(localStorage.getItem("token")).toBe(tokenA);
  });
});
