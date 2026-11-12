import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockSessionPage from "./MockSessionPage.jsx";
import { completeMockSession, getMockSession, saveMockSessionAnswer } from "../services/mockSessionService.js";

vi.mock("../services/mockSessionService.js", () => ({
  getMockSession: vi.fn(),
  saveMockSessionAnswer: vi.fn(),
  completeMockSession: vi.fn(),
}));

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const QUESTION_A = "question-a";
const QUESTION_B = "question-b";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(id, questionId, questionText) {
  return {
    _id: id,
    status: "in-progress",
    answers: [{ question: questionId, questionText, answerText: "", order: 0 }],
  };
}

function renderSession(sessionId = SESSION_A) {
  const router = createMemoryRouter([
    { path: "/mock-sessions/:sessionId", element: <MockSessionPage /> },
  ], { initialEntries: [`/mock-sessions/${sessionId}`] });
  return { ...render(<RouterProvider router={router} />), router };
}

function editAnswer(text) {
  const answer = screen.getByRole("textbox", { name: "Your answer" });
  fireEvent.change(answer, { target: { value: text } });
  return answer;
}

async function advanceTimers(milliseconds) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  getMockSession.mockImplementation(async (sessionId) => (
    sessionId === SESSION_B
      ? makeSession(SESSION_B, QUESTION_B, "Question from session B")
      : makeSession(SESSION_A, QUESTION_A, "Question from session A")
  ));
  saveMockSessionAnswer.mockResolvedValue({ success: true, saveStatus: "saved" });
  completeMockSession.mockResolvedValue({ status: "completed" });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("MockSessionPage autosave", () => {
  it("debounces a save until 800 ms after the edit", async () => {
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("My answer");

    await advanceTimers(799);
    expect(saveMockSessionAnswer).not.toHaveBeenCalled();

    await advanceTimers(1);
    await flushPromises();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
    expect(saveMockSessionAnswer).toHaveBeenCalledWith(SESSION_A, QUESTION_A, "My answer", { keepalive: false });
  });

  it("saves the latest edit after an earlier request resolves", async () => {
    const firstSave = deferred();
    saveMockSessionAnswer.mockReturnValueOnce(firstSave.promise);
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("First draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    editAnswer("Latest draft");
    await act(async () => { firstSave.resolve({ success: true }); });

    await flushPromises();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A, "Latest draft", { keepalive: false });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("shows Save failed and Retry when a save rejects", async () => {
    saveMockSessionAnswer.mockRejectedValueOnce(new Error("Temporary save error"));
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Unsaved answer");
    await advanceTimers(800);

    await flushPromises();
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("locks editing and cancels queued autosaves when the server reports a completed session", async () => {
    const completedError = Object.assign(new Error("Completed sessions cannot be modified"), { status: 409 });
    const pendingSave = deferred();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("First answer");
    await advanceTimers(800);
    editAnswer("Edit queued during request");
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await act(async () => { pendingSave.reject(completedError); });
    await flushPromises();

    expect(screen.getByText(/Completed session/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText("Session completed. This answer could not be saved.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Another edit" } });
    await advanceTimers(1600);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not send another request when a retry gets the completed-session response", async () => {
    const user = userEvent.setup();
    const completedError = Object.assign(new Error("Completed sessions cannot be modified"), { status: 409 });
    const retryResponse = deferred();
    saveMockSessionAnswer
      .mockRejectedValueOnce(new Error("Temporary save error"))
      .mockReturnValueOnce(retryResponse.promise);
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Answer to retry");
    await advanceTimers(800);
    await flushPromises();
    const retryButton = screen.getByRole("button", { name: "Retry" });

    vi.useRealTimers();
    await user.click(retryButton);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    await act(async () => {
      retryResponse.reject(completedError);
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(retryButton);
    });
    await flushPromises();

    expect(screen.getByText(/Completed session/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
  });

  it("retries the latest answer manually and displays Saved", async () => {
    const user = userEvent.setup();
    saveMockSessionAnswer
      .mockRejectedValueOnce(new Error("Temporary save error"))
      .mockResolvedValueOnce({ success: true });
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Retry this answer");
    await advanceTimers(800);
    await flushPromises();
    expect(screen.getByText("Save failed")).toBeInTheDocument();

    vi.useRealTimers();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await flushPromises();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenLastCalledWith(SESSION_A, QUESTION_A, "Retry this answer", { keepalive: false });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("serializes rapid edits during an in-flight save and submits the final text", async () => {
    const firstSave = deferred();
    saveMockSessionAnswer.mockReturnValueOnce(firstSave.promise);
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Initial draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    editAnswer("Second draft");
    editAnswer("Final draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await act(async () => { firstSave.resolve({ success: true }); });
    await flushPromises();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A, "Final draft", { keepalive: false });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("drains session A saves before loading session B and clears old timers", async () => {
    const firstSave = deferred();
    saveMockSessionAnswer.mockReturnValueOnce(firstSave.promise);
    const { router } = renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Session A first draft");
    await advanceTimers(800);
    editAnswer("Session A latest draft");

    await act(async () => { await router.navigate(`/mock-sessions/${SESSION_B}`); });
    expect(saveMockSessionAnswer).toHaveBeenCalledWith(SESSION_A, QUESTION_A, "Session A first draft", { keepalive: false });
    expect(getMockSession).not.toHaveBeenCalledWith(SESSION_B);

    await act(async () => { firstSave.resolve({ success: true }); });
    await flushPromises();
    expect(screen.getByText("Question from session B")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("");
    expect(screen.queryByText("Question from session A")).not.toBeInTheDocument();

    const oldSessionCalls = saveMockSessionAnswer.mock.calls.length;
    await advanceTimers(1600);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(oldSessionCalls);
    expect(saveMockSessionAnswer.mock.calls.every(([id]) => id === SESSION_A)).toBe(true);
  });

  it("blocks completion when a pending answer save fails", async () => {
    const user = userEvent.setup();
    const pendingSave = deferred();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    renderSession();
    expect(await screen.findByText("Question from session A")).toBeInTheDocument();
    vi.useFakeTimers();
    editAnswer("Answer before completion");
    await advanceTimers(800);

    vi.useRealTimers();
    await user.click(screen.getByRole("button", { name: "Complete Interview" }));
    await user.click(screen.getByRole("button", { name: "Confirm completion" }));
    await act(async () => { pendingSave.reject(new Error("Save rejected")); });

    await flushPromises();
    expect(screen.getByRole("alert")).toHaveTextContent("Save rejected");
    expect(completeMockSession).not.toHaveBeenCalled();
  });
});
