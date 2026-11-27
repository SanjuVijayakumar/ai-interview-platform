import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react/pure";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockSessionPage, { CapabilityBoundMockSessionPage } from "./MockSessionPage.jsx";
import { completeMockSession, getMockSession, saveMockSessionAnswer } from "../services/mockSessionService.js";

vi.mock("../services/mockSessionService.js", () => ({
  getMockSession: vi.fn(),
  saveMockSessionAnswer: vi.fn(),
  completeMockSession: vi.fn(),
}));

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const QUESTION_A = "question-a";
const QUESTION_A2 = "question-a2";
const QUESTION_B = "question-b";
const savedResponse = { success: true, saveStatus: "saved" };
const pendingSaves = new Set();

function deferSave() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const save = { promise, resolve, reject };
  pendingSaves.add(save);
  const remove = () => pendingSaves.delete(save);
  void promise.then(remove, remove);
  return save;
}

function makeSession(id, questionId, questionText) {
  return {
    _id: id,
    status: "in-progress",
    answers: [{ question: questionId, questionText, answerText: "", order: 0 }],
  };
}

function makeTwoQuestionSession() {
  return {
    _id: SESSION_A,
    status: "in-progress",
    answers: [
      { question: QUESTION_A, questionText: "Question from session A", answerText: "", order: 0 },
      { question: QUESTION_A2, questionText: "Second question from session A", answerText: "", order: 1 },
    ],
  };
}

async function dispatchPageHide() {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
}

async function renderSession({ fakeTimers = true, page = <MockSessionPage /> } = {}) {
  if (fakeTimers) vi.useFakeTimers();
  const router = createMemoryRouter([
    { path: "/mock-sessions/:sessionId", element: page },
    { path: "/results/:sessionId", element: <p>Results</p> },
  ], { initialEntries: [`/mock-sessions/${SESSION_A}`] });
  await act(async () => { render(<RouterProvider router={router} />); });
  return router;
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

beforeEach(() => {
  getMockSession.mockReset().mockImplementation(async (sessionId) => (
    sessionId === SESSION_B
      ? makeSession(SESSION_B, QUESTION_B, "Question from session B")
      : makeSession(SESSION_A, QUESTION_A, "Question from session A")
  ));
  saveMockSessionAnswer.mockReset().mockResolvedValue(savedResponse);
  completeMockSession.mockReset().mockResolvedValue({ status: "completed" });
});

afterEach(async () => {
  try {
    await act(async () => {
      cleanup();
      // Release saves left pending if an assertion failed, while exit flushing can still use the mocks.
      const unfinished = [...pendingSaves];
      for (const save of unfinished) save.resolve(savedResponse);
      await Promise.allSettled(unfinished.map((save) => save.promise));
    });
  } finally {
    vi.useRealTimers();
  }
});

describe("MockSessionPage autosave", () => {
  it("opens saved results after completing the existing session", async () => {
    const user = userEvent.setup();
    const router = await renderSession({ fakeTimers: false });
    expect(screen.getByText("Question from session A")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Complete Interview" }));
    await user.click(screen.getByRole("button", { name: "Confirm completion" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${SESSION_A}`));
    expect(completeMockSession).toHaveBeenCalledTimes(1);
    expect(getMockSession).toHaveBeenCalledTimes(1);
  });

  it("debounces a save until 800 ms after the edit", async () => {
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Earlier answer");
    await advanceTimers(400);
    editAnswer("My answer");

    await advanceTimers(799);
    expect(saveMockSessionAnswer).not.toHaveBeenCalled();

    await advanceTimers(1);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
    expect(saveMockSessionAnswer).toHaveBeenCalledWith(SESSION_A, QUESTION_A, "My answer", { keepalive: false });
  });

  it("saves the latest edit after an earlier request resolves", async () => {
    const firstSave = deferSave();
    const latestSave = deferSave();
    saveMockSessionAnswer
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(latestSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("First draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(1, SESSION_A, QUESTION_A, "First draft", { keepalive: false });

    editAnswer("Latest draft");
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { firstSave.resolve({ success: true }); });

    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A, "Latest draft", { keepalive: false });
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await act(async () => { latestSave.resolve(savedResponse); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
  });

  it("shows Save failed and Retry when a save rejects", async () => {
    const pendingSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Unsaved answer");
    await advanceTimers(800);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await act(async () => { pendingSave.reject(new Error("Temporary save error")); });
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
  });

  it("locks editing and cancels queued autosaves when the server reports a completed session", async () => {
    const completedError = Object.assign(new Error("Completed sessions cannot be modified"), { status: 409 });
    const pendingSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("First answer");
    await advanceTimers(800);
    editAnswer("Edit queued during request");
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await act(async () => { pendingSave.reject(completedError); });

    expect(screen.getByText(/Completed session/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText("Session completed. This answer could not be saved.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Another edit" } });
    await dispatchPageHide();
    await advanceTimers(1600);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not send another request when a retry gets the completed-session response", async () => {
    const completedError = Object.assign(new Error("Completed sessions cannot be modified"), { status: 409 });
    const firstSave = deferSave();
    const retryResponse = deferSave();
    saveMockSessionAnswer
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(retryResponse.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Answer to retry");
    await advanceTimers(800);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    await act(async () => { firstSave.reject(new Error("Temporary save error")); });
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry" });

    fireEvent.click(retryButton);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await act(async () => {
      retryResponse.reject(completedError);
      // Let the save handler observe the rejection before trying the old button.
      await retryResponse.promise.catch(() => {});
      fireEvent.click(retryButton);
    });

    expect(screen.getByText(/Completed session/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
  });

  it("dispatches all dirty answers on pagehide with their captured IDs and keepalive", async () => {
    getMockSession.mockResolvedValueOnce(makeTwoQuestionSession());
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("First answer");
    fireEvent.click(screen.getByRole("button", { name: /Go to question 2/ }));
    editAnswer("Second answer");

    await dispatchPageHide();

    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(1, SESSION_A, QUESTION_A, "First answer", { keepalive: true });
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A2, "Second answer", { keepalive: true });
  });

  it("keeps dispatching other exit saves when one fails and retries that answer independently", async () => {
    getMockSession.mockResolvedValueOnce(makeTwoQuestionSession());
    const firstAnswerFailure = deferSave();
    const secondAnswerSave = deferSave();
    const firstAnswerCalls = [];
    saveMockSessionAnswer.mockImplementation((sessionId, questionId, text, options) => {
      if (questionId === QUESTION_A2) return secondAnswerSave.promise;
      firstAnswerCalls.push({ sessionId, text, options });
      return firstAnswerCalls.length === 1
        ? firstAnswerFailure.promise
        : Promise.resolve({ success: true });
    });
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("First answer");
    fireEvent.click(screen.getByRole("button", { name: /Go to question 2/ }));
    editAnswer("Second answer");

    await dispatchPageHide();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer.mock.calls.map(([, questionId]) => questionId)).toEqual([QUESTION_A, QUESTION_A2]);

    await act(async () => { firstAnswerFailure.reject(new Error("Exit save failed")); });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(3);
    expect(saveMockSessionAnswer.mock.calls[2]).toEqual([SESSION_A, QUESTION_A, "First answer", { keepalive: true }]);

    await act(async () => { secondAnswerSave.resolve({ success: true }); });
  });

  it("does not duplicate an answer request already in flight during pagehide", async () => {
    const inFlightSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(inFlightSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Pending answer");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await dispatchPageHide();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await act(async () => { inFlightSave.resolve({ success: true }); });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not flush answers on pagehide for a completed session", async () => {
    getMockSession.mockResolvedValueOnce({ ...makeSession(SESSION_A, QUESTION_A, "Question from session A"), status: "completed" });
    await renderSession();
    expect(screen.getByText(/Completed session/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();

    await dispatchPageHide();

    expect(saveMockSessionAnswer).not.toHaveBeenCalled();
  });

  it("flushes on hidden visibility and flushes only the later edit on unmount", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      await renderSession();
      editAnswer("Visibility draft");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(saveMockSessionAnswer).not.toHaveBeenCalled();

      visibility.mockReturnValue("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
      expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(1, SESSION_A, QUESTION_A, "Visibility draft", { keepalive: true });

      editAnswer("Unmount draft");
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
      await act(async () => { cleanup(); });
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
      expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A, "Unmount draft", { keepalive: true });

      await dispatchPageHide();
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await advanceTimers(800);
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });

  it("closes the completion dialog when an answer save reports the session completed", async () => {
    const completedError = Object.assign(new Error("Completed sessions cannot be modified"), { status: 409 });
    const pendingSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Answer before completion");
    await advanceTimers(800);

    fireEvent.click(screen.getByRole("button", { name: "Complete Interview" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm completion" }));
    await act(async () => { pendingSave.reject(completedError); });

    expect(screen.getByText(/Completed session.*1 question/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(completeMockSession).not.toHaveBeenCalled();
  });

  it("retries the latest answer manually and displays Saved", async () => {
    const firstSave = deferSave();
    const retrySave = deferSave();
    saveMockSessionAnswer
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(retrySave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Retry this answer");
    await advanceTimers(800);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await act(async () => { firstSave.reject(new Error("Temporary save error")); });
    expect(screen.getByText("Save failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenLastCalledWith(SESSION_A, QUESTION_A, "Retry this answer", { keepalive: false });
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await act(async () => { retrySave.resolve(savedResponse); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
  });

  it("serializes rapid edits during an in-flight save and submits the final text", async () => {
    const firstSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(firstSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Initial draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    editAnswer("Second draft");
    editAnswer("Final draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);

    await act(async () => { firstSave.resolve({ success: true }); });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenNthCalledWith(2, SESSION_A, QUESTION_A, "Final draft", { keepalive: false });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("drains session A saves before loading session B and clears old timers", async () => {
    const firstSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(firstSave.promise);
    const router = await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Session A first draft");
    await advanceTimers(800);
    editAnswer("Session A latest draft");

    await act(async () => { await router.navigate(`/mock-sessions/${SESSION_B}`); });
    expect(saveMockSessionAnswer).toHaveBeenCalledWith(SESSION_A, QUESTION_A, "Session A first draft", { keepalive: false });
    expect(getMockSession).not.toHaveBeenCalledWith(SESSION_B);

    await act(async () => { firstSave.resolve({ success: true }); });
    expect(screen.getByText("Question from session B")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("");
    expect(screen.queryByText("Question from session A")).not.toBeInTheDocument();

    const oldSessionCalls = saveMockSessionAnswer.mock.calls.length;
    await advanceTimers(1600);
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(oldSessionCalls);
    expect(saveMockSessionAnswer.mock.calls.every(([id]) => id === SESSION_A)).toBe(true);
  });

  it("blocks completion when a pending answer save fails", async () => {
    const pendingSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(pendingSave.promise);
    await renderSession();
    expect(screen.getByText("Question from session A")).toBeInTheDocument();
    editAnswer("Answer before completion");
    await advanceTimers(800);

    fireEvent.click(screen.getByRole("button", { name: "Complete Interview" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm completion" }));
    await act(async () => { pendingSave.reject(new Error("Save rejected")); });

    expect(screen.getByRole("alert")).toHaveTextContent("Save rejected");
    expect(completeMockSession).not.toHaveBeenCalled();
  });
});

describe("capability-bound mock sessions", () => {
  let capability;

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
  });

  function renderBound() {
    return renderSession({ page: <CapabilityBoundMockSessionPage capability={capability} /> });
  }

  function confirmCompletion() {
    fireEvent.click(screen.getByRole("button", { name: "Complete Interview" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm completion" }));
  }

  it.each([undefined, null, {}, { fetch: () => {}, isCurrent: () => false }])(
    "fails closed for an unusable capability",
    async (unusable) => {
      await renderSession({ page: <CapabilityBoundMockSessionPage capability={unusable} /> });
      expect(getMockSession).not.toHaveBeenCalled();
      expect(screen.getByText(/authentication session.*no longer current/i)).toBeInTheDocument();
    },
  );

  it("ignores a load that resolves after credential replacement", async () => {
    const load = deferSave();
    getMockSession.mockReturnValueOnce(load.promise);
    await renderBound();
    expect(getMockSession).toHaveBeenCalledExactlyOnceWith(SESSION_A, { capability });
    capability.isCurrent.mockReturnValue(false);
    await act(async () => { load.resolve(makeSession(SESSION_A, QUESTION_A, "Old account question")); });
    expect(screen.queryByText("Old account question")).not.toBeInTheDocument();
  });

  it.each([false, true])("binds both drafts and suppresses a stale queued dispatch (%s)", async (stale) => {
    const first = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(first.promise);
    await renderBound();
    expect(getMockSession).toHaveBeenCalledExactlyOnceWith(SESSION_A, { capability });
    editAnswer("First draft");
    await advanceTimers(800);
    expect(saveMockSessionAnswer).toHaveBeenCalledExactlyOnceWith(SESSION_A, QUESTION_A, "First draft", { capability, keepalive: false });
    editAnswer("Latest draft");
    if (stale) capability.isCurrent.mockReturnValue(false);
    await act(async () => { first.resolve(savedResponse); });
    if (stale) {
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    } else {
      expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
      expect(saveMockSessionAnswer).toHaveBeenLastCalledWith(SESSION_A, QUESTION_A, "Latest draft", { capability, keepalive: false });
      expect(screen.getByText("Saved")).toBeInTheDocument();
    }
  });

  it.each([false, true])("retries only with a current originating capability (%s)", async (stale) => {
    saveMockSessionAnswer.mockRejectedValueOnce(new Error("Temporary save error"));
    await renderBound();
    editAnswer("Retry draft");
    await advanceTimers(800);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    if (stale) capability.isCurrent.mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(stale ? 1 : 2);
    expect(saveMockSessionAnswer).toHaveBeenLastCalledWith(SESSION_A, QUESTION_A, "Retry draft", { capability, keepalive: false });
    expect(screen.getByText(stale ? "Save failed" : "Saved")).toBeInTheDocument();
  });

  it("uses the same capability for pagehide, visibility, and unmount", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      await renderBound();
      editAnswer("Pagehide draft");
      await dispatchPageHide();
      editAnswer("Visibility draft");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      editAnswer("Unmount draft");
      await act(async () => { cleanup(); });
      expect(saveMockSessionAnswer.mock.calls).toEqual(
        ["Pagehide draft", "Visibility draft", "Unmount draft"].map((draft) => (
          [SESSION_A, QUESTION_A, draft, { capability, keepalive: true }]
        )),
      );
    } finally {
      visibility.mockRestore();
    }
  });

  it("drains the originating session before loading the next route", async () => {
    const originalSave = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(originalSave.promise);
    const router = await renderBound();
    editAnswer("First draft");
    await advanceTimers(800);
    editAnswer("Latest draft for A");
    await act(async () => { await router.navigate(`/mock-sessions/${SESSION_B}`); });
    expect(getMockSession).toHaveBeenCalledExactlyOnceWith(SESSION_A, { capability });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { originalSave.resolve(savedResponse); });
    expect(saveMockSessionAnswer).toHaveBeenCalledTimes(2);
    expect(saveMockSessionAnswer).toHaveBeenLastCalledWith(SESSION_A, QUESTION_A, "Latest draft for A", { capability, keepalive: true });
    expect(getMockSession).toHaveBeenLastCalledWith(SESSION_B, { capability });
    expect(screen.getByText("Question from session B")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("does not duplicate a bound in-flight save on pagehide", async () => {
    const inFlight = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(inFlight.promise);
    await renderBound();
    editAnswer("In-flight draft");
    await advanceTimers(800);
    await dispatchPageHide();
    await act(async () => { inFlight.resolve(savedResponse); });
    expect(saveMockSessionAnswer).toHaveBeenCalledExactlyOnceWith(SESSION_A, QUESTION_A, "In-flight draft", { capability, keepalive: false });
  });

  it("blocks stale timers, completion, and exit writes", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      await renderBound();
      editAnswer("Old account draft");
      capability.isCurrent.mockReturnValue(false);
      await advanceTimers(800);
      confirmCompletion();
      await dispatchPageHide();
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { cleanup(); });
      expect(saveMockSessionAnswer).not.toHaveBeenCalled();
      expect(completeMockSession).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it("waits for the bound save and completes with the same capability", async () => {
    const save = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(save.promise);
    const router = await renderBound();
    editAnswer("Completion draft");
    confirmCompletion();
    expect(saveMockSessionAnswer).toHaveBeenCalledExactlyOnceWith(SESSION_A, QUESTION_A, "Completion draft", { capability, keepalive: false });
    expect(completeMockSession).not.toHaveBeenCalled();
    await act(async () => { save.resolve(savedResponse); });
    expect(completeMockSession).toHaveBeenCalledExactlyOnceWith(SESSION_A, { capability });
    expect(router.state.location.pathname).toBe(`/results/${SESSION_A}`);
  });

  it.each([false, true])("blocks completion after a required save fails or becomes stale (%s)", async (stale) => {
    const save = deferSave();
    saveMockSessionAnswer.mockReturnValueOnce(save.promise);
    await renderBound();
    editAnswer("Completion draft");
    confirmCompletion();
    await act(async () => {
      if (stale) {
        capability.isCurrent.mockReturnValue(false);
        save.resolve(savedResponse);
      } else {
        save.reject(new Error("Required save failed"));
      }
    });
    expect(completeMockSession).not.toHaveBeenCalled();
    if (!stale) expect(screen.getByRole("alert")).toHaveTextContent("Required save failed");
  });

  it.each(["capability", "route"])("ignores completion after its %s is superseded", async (superseded) => {
    const completion = deferSave();
    completeMockSession.mockReturnValueOnce(completion.promise);
    const router = await renderBound();
    confirmCompletion();
    expect(completeMockSession).toHaveBeenCalledExactlyOnceWith(SESSION_A, { capability });
    if (superseded === "capability") capability.isCurrent.mockReturnValue(false);
    else await act(async () => { await router.navigate(`/mock-sessions/${SESSION_B}`); });
    await act(async () => { completion.resolve({ status: "completed" }); });
    expect(router.state.location.pathname).toBe(`/mock-sessions/${superseded === "capability" ? SESSION_A : SESSION_B}`);
    expect(screen.queryByText(/Completed session/)).not.toBeInTheDocument();
  });

  it.each([undefined, "session_completed"])("locks editing only on normalized 409 metadata (%s)", async (errorCode) => {
    const error = Object.assign(new Error("Completed sessions cannot be modified"), {
      status: 409,
      data: { errorCode },
    });
    saveMockSessionAnswer.mockRejectedValueOnce(error);
    await renderBound();
    editAnswer("Draft");
    await advanceTimers(800);
    const answer = screen.getByRole("textbox", { name: "Your answer" });
    if (errorCode) {
      expect(answer).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    } else {
      expect(answer).toBeEnabled();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    }
  });
});
