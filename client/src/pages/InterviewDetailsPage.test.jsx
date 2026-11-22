import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InterviewDetailsPage from "./InterviewDetailsPage.jsx";
import { createQuestion, generateInterviewQuestions, getQuestions } from "../services/questionService.js";
import { getInterviewById } from "../services/interviewService.js";
import { findInProgressMockSession } from "../services/mockSessionService.js";

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

function renderPage() {
  const router = createMemoryRouter([
    { path: "/interviews/:interviewId", element: <InterviewDetailsPage /> },
    { path: "/login", element: <p>Login route</p> },
  ], { initialEntries: ["/interviews/interview-1"] });
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
  findInProgressMockSession.mockResolvedValue(null);
  generateInterviewQuestions.mockResolvedValue(generatedQuestions);
});

afterEach(() => cleanup());

describe("InterviewDetailsPage AI question generation", () => {
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
