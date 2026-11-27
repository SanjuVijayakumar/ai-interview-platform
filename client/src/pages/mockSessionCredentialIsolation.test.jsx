import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";
import { authenticatedRequest } from "../services/authenticatedRequest.js";
import { findInProgressMockSession, saveMockSessionAnswer } from "../services/mockSessionService.js";
import { CapabilityBoundMockInterviewControls } from "./InterviewDetailsPage.jsx";
import { CapabilityBoundMockSessionPage } from "./MockSessionPage.jsx";

const API = "http://localhost:5000/api";
const TOKEN_A = "synthetic-token-a";
const TOKEN_B = "synthetic-token-b";
const USER_A = { id: "a".repeat(24), name: "User A", email: "a@example.test", role: "user" };
const USER_B = { id: "b".repeat(24), name: "User B", email: "b@example.test", role: "user" };
const SESSION_ID = "session-a";
const QUESTION_ID = "question-a";
const INTERVIEW_ID = "interview-a";
const SESSION_ROUTE = `/mock-session/${SESSION_ID}`;
const INTERVIEW_ROUTE = `/interviews/${INTERVIEW_ID}`;
const RESULTS_ROUTE = `/results/${SESSION_ID}`;
const SESSION_PATH = `/mock-sessions/${SESSION_ID}`;
const SAVE_PATH = `${SESSION_PATH}/answers/${QUESTION_ID}`;
const COMPLETE_PATH = `${SESSION_PATH}/complete`;
const CREATE_PATH = `/interviews/${INTERVIEW_ID}/sessions`;
const LOOKUP_PATH = `${CREATE_PATH}/in-progress`;

const session = {
  _id: SESSION_ID,
  status: "in-progress",
  answers: [{ question: QUESTION_ID, questionText: "Originating question", answerText: "", order: 0 }],
};
const loaded = { success: true, session };
const saved = { success: true, saveStatus: "saved" };
const completed = { success: true, session: { ...session, status: "completed" } };
const missingSession = { success: false, message: "No in-progress session found" };
const completedConflict = { success: false, message: "Completed sessions cannot be modified" };

let expectedRequests;
let actualRequests;
let pendingResponses;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferResponse() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  const response = { promise, resolve };
  pendingResponses.add(response);
  void promise.then(() => pendingResponses.delete(response));
  return response;
}

function expectRequest(path, response, { method = "GET", token = TOKEN_A, keepalive, body } = {}) {
  expectedRequests.push({
    request: {
      url: API + path,
      method,
      authorization: `Bearer ${token}`,
      redirect: "error",
      keepalive,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    response,
  });
}

function expectIdentity(token = TOKEN_A, user = USER_A) {
  expectRequest("/auth/profile", json({ success: true, user }), { token });
}

function expectSave(answerText, response = json(saved), keepalive = false) {
  expectRequest(SAVE_PATH, response, { method: "PATCH", body: { answerText }, keepalive });
}

function expectCompletion(response = json(completed)) {
  expectRequest(COMPLETE_PATH, response, { method: "POST" });
}

function expectCreation(response = json(loaded, 201)) {
  expectRequest(CREATE_PATH, response, { method: "POST" });
}

function writes() {
  return actualRequests.filter(({ method }) => method === "PATCH" || method === "POST");
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.localStorage.setItem("token", TOKEN_A);
  expectedRequests = [];
  actualRequests = [];
  pendingResponses = new Set();
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const request = {
      url: String(url),
      method: options.method ?? "GET",
      authorization: new Headers(options.headers).get("Authorization"),
      redirect: options.redirect,
      keepalive: options.keepalive,
      body: options.body,
    };
    const next = expectedRequests[actualRequests.length];
    actualRequests.push(request);
    if (!next || Object.keys(request).some((key) => request[key] !== next.request[key])) {
      throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    }
    return typeof next.response === "function" ? next.response() : next.response;
  }));
});

afterEach(async () => {
  try {
    await act(async () => {
      cleanup();
      const unfinished = [...pendingResponses];
      unfinished.forEach(({ resolve }) => resolve(json({ success: false }, 503)));
      await Promise.all(unfinished.map(({ promise }) => promise));
    });
    // Assert outside the mock too, since the app deliberately handles fetch rejections.
    expect(actualRequests).toEqual(expectedRequests.map(({ request }) => request));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.useRealTimers();
  }
});

function AuthProbe({ report }) {
  const auth = useAuth();
  useEffect(() => { report(auth); }, [auth, report]);
  return null;
}

async function mountProvider() {
  let auth;
  const report = (value) => { auth = value; };
  const tree = (children) => (
    <AuthProvider>
      <AuthProbe report={report} />
      {children}
    </AuthProvider>
  );

  expectIdentity();
  let view;
  await act(async () => { view = render(tree()); });
  expect(auth.session).toMatchObject({ status: "authenticated", user: USER_A });

  return {
    auth: () => auth,
    async mountBoundPage({ route = SESSION_ROUTE, capability = auth.captureAuthenticatedRequest() } = {}) {
      expect(capability?.isCurrent()).toBe(true);
      const router = createMemoryRouter([
        { path: "/mock-session/:sessionId", element: <CapabilityBoundMockSessionPage capability={capability} /> },
        {
          path: "/interviews/:interviewId",
          element: <CapabilityBoundMockInterviewControls capability={capability} hasQuestions />,
        },
        { path: "/results/:sessionId", element: <p>Results route</p> },
        { path: "/login", element: <p>Login route</p> },
      ], { initialEntries: [route] });
      await act(async () => { view.rerender(tree(<RouterProvider router={router} />)); });
      return { router, capability };
    },
    async unmountPage() {
      await act(async () => { view.rerender(tree()); });
    },
  };
}

async function mountSession() {
  const harness = await mountProvider();
  expectRequest(SESSION_PATH, json(loaded));
  const page = await harness.mountBoundPage();
  expect(screen.getByText("Originating question")).toBeInTheDocument();
  return { ...harness, ...page };
}

async function mountControls(response = json(missingSession, 404)) {
  const harness = await mountProvider();
  expectRequest(LOOKUP_PATH, response);
  const page = await harness.mountBoundPage({ route: INTERVIEW_ROUTE });
  return { ...harness, ...page };
}

function edit(text) {
  fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: text } });
}

async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function settle(request, response) {
  await act(async () => { request.resolve(response); });
}

async function click(name) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

async function confirmCompletion() {
  await click("Complete Interview");
  await click("Confirm completion");
}

async function pagehide() {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
}

async function hideDocument() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

async function verifyAccountReplacement(harness) {
  expectIdentity(TOKEN_B, USER_B);
  await act(async () => {
    window.localStorage.setItem("token", TOKEN_B);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "token",
      oldValue: TOKEN_A,
      newValue: TOKEN_B,
      storageArea: window.localStorage,
    }));
  });
  expectAccountB(harness);
}

function expectAccountB({ auth, capability }) {
  expect(auth().session).toMatchObject({ status: "authenticated", user: USER_B });
  expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
  expect(capability.isCurrent()).toBe(false);
}

describe("real mock-session credential isolation", () => {
  it("loads and debounces the latest answer with the original bearer token", async () => {
    const { capability } = await mountSession();
    const save = deferResponse();
    edit("Earlier draft");
    await advance(400);
    edit("Latest draft");
    expectSave("Latest draft", save.promise);
    await advance(799);
    expect(writes()).toHaveLength(0);
    await advance(1);
    expect(writes()).toHaveLength(1);
    expect(capability.isCurrent()).toBe(true);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await settle(save, json(saved));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("prevents a queued save and exit flush after provider logout", async () => {
    const harness = await mountSession();
    edit("Logged-out draft");
    await act(async () => { harness.auth().logout(); });
    expect(harness.capability.isCurrent()).toBe(false);
    expect(harness.auth().session.status).toBe("unauthenticated");
    expect(window.localStorage.getItem("token")).toBeNull();
    await advance(800);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await pagehide();
    await harness.unmountPage();
    expect(writes()).toHaveLength(0);
  });

  it("discards a pending initial load after account replacement", async () => {
    const harness = await mountProvider();
    const load = deferResponse();
    expectRequest(SESSION_PATH, load.promise);
    const page = await harness.mountBoundPage();
    await verifyAccountReplacement({ ...harness, ...page });
    await settle(load, json(loaded));
    expect(screen.queryByText("Originating question")).not.toBeInTheDocument();
    expect(page.router.state.location.pathname).toBe(SESSION_ROUTE);
    expectAccountB({ ...harness, ...page });
  });

  it.each([false, true])("blocks cross-tab replacement writes before or after the event (%s)", async (beforeEvent) => {
    const harness = await mountSession();
    edit("Cross-tab draft");
    if (beforeEvent) {
      window.localStorage.setItem("token", TOKEN_B);
      expect(harness.auth().session.user).toEqual(USER_A);
      expect(harness.capability.isCurrent()).toBe(false);
      await advance(800);
      expect(writes()).toHaveLength(0);
    }
    await verifyAccountReplacement(harness);
    if (!beforeEvent) await advance(800);
    await hideDocument();
    await harness.unmountPage();
    expect(writes()).toHaveLength(0);
    expectAccountB(harness);
  });

  it.each([TOKEN_A, TOKEN_B])("isolates a same-user relogin with token %s", async (newToken) => {
    const harness = await mountSession();
    edit("Previous generation");
    await act(async () => { harness.auth().logout(); });
    expectIdentity(newToken, USER_A);
    await act(async () => {
      window.localStorage.setItem("token", newToken);
      await harness.auth().completeLogin();
    });
    const replacement = harness.auth().captureAuthenticatedRequest();
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(harness.capability.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
    await advance(800);
    expect(writes()).toHaveLength(0);
    await harness.unmountPage();
    expectRequest(SESSION_PATH, json(loaded), { token: newToken });
    await harness.mountBoundPage({ capability: replacement });
    expect(screen.getByText("Originating question")).toBeInTheDocument();
  });

  it.each([200, 503])("retains its draft and capability during background verification (%s)", async (status) => {
    const harness = await mountSession();
    const profile = deferResponse();
    edit("Revalidation draft");
    expectRequest("/auth/profile", profile.promise);
    let verification;
    await act(async () => { verification = harness.auth().verifySession(); });
    expect(harness.auth().session.isRevalidating).toBe(true);
    expect(harness.capability.isCurrent()).toBe(true);
    expectSave("Revalidation draft");
    await advance(800);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    await settle(profile, json({ success: status === 200, user: USER_A }, status));
    await verification;
    expect(harness.auth().session).toMatchObject({ status: "authenticated", isRevalidating: false, user: USER_A });
    expect(harness.auth().session.error?.category).toBe(status === 503 ? "service-unavailable" : undefined);
    expect(harness.capability.isCurrent()).toBe(true);
    expect(screen.getByRole("textbox")).toHaveValue("Revalidation draft");
    expect(writes()).toHaveLength(1);
  });

  it.each([200, 401, 409])("ignores an old in-flight response and its queued draft (%s)", async (status) => {
    const harness = await mountSession();
    const save = deferResponse();
    expectSave("First draft", save.promise);
    edit("First draft");
    await advance(800);
    edit("Queued draft");
    await verifyAccountReplacement(harness);
    await settle(save, json(status === 200 ? saved : completedConflict, status));
    await advance(800);
    expect(writes()).toHaveLength(1);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByText(/Session completed\. This answer/)).not.toBeInTheDocument();
    expect(harness.router.state.location.pathname).toBe(SESSION_ROUTE);
    expectAccountB(harness);
  });

  it.each(["network", "forbidden", "replacement"])("handles manual retry after %s", async (scenario) => {
    const harness = await mountSession();
    const response = scenario === "network"
      ? () => { throw new TypeError("Synthetic transport failure"); }
      : json({ success: false, message: "Save denied" }, scenario === "forbidden" ? 403 : 500);
    expectSave("Retry draft", response);
    edit("Retry draft");
    await advance(800);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    if (scenario === "replacement") {
      await verifyAccountReplacement(harness);
    } else {
      expect(harness.auth().session).toMatchObject({ status: "authenticated", user: USER_A });
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expectSave("Retry draft");
    }
    await click("Retry");
    expect(writes()).toHaveLength(scenario === "replacement" ? 1 : 2);
    expect(screen.getByText(scenario === "replacement" ? "Save failed" : "Saved")).toBeInTheDocument();
  });

  it("uses the current originating credentials on pagehide, hidden visibility, and unmount", async () => {
    const harness = await mountSession();
    edit("Pagehide draft");
    expectSave("Pagehide draft", json(saved), true);
    await pagehide();
    edit("Visibility draft");
    expectSave("Visibility draft", json(saved), true);
    await hideDocument();
    edit("Unmount draft");
    expectSave("Unmount draft", json(saved), true);
    await harness.unmountPage();
    await pagehide();
    await advance(800);
    expect(writes()).toHaveLength(3);
    expect(harness.capability.isCurrent()).toBe(true);
  });

  it("deduplicates a pending exit save and binds the queued keepalive request", async () => {
    await mountSession();
    const save = deferResponse();
    expectSave("In flight", save.promise);
    edit("In flight");
    await advance(800);
    edit("Exit draft");
    await pagehide();
    await pagehide();
    expect(writes()).toHaveLength(1);
    expectSave("Exit draft", json(saved), true);
    await settle(save, json(saved));
    expect(writes()).toHaveLength(2);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("drains an old route's queued write with its original IDs before loading the next route", async () => {
    const { router } = await mountSession();
    const save = deferResponse();
    expectSave("First draft on old route", save.promise);
    edit("First draft on old route");
    await advance(800);
    edit("Queued draft on old route");
    await act(async () => { await router.navigate("/mock-session/session-next"); });
    expect(writes()).toHaveLength(1);
    expect(actualRequests.at(-1).url).toBe(API + SAVE_PATH);
    expectSave("Queued draft on old route", json(saved), true);
    expectRequest("/mock-sessions/session-next", json({
      success: true,
      session: {
        ...session,
        _id: "session-next",
        answers: [{ ...session.answers[0], questionText: "Next route question" }],
      },
    }));
    await settle(save, json(saved));
    expect(writes()).toHaveLength(2);
    expect(screen.getByText("Next route question")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("lets a current 401 invalidate the provider and block queued writes", async () => {
    const harness = await mountSession();
    const save = deferResponse();
    expectSave("Unauthorized draft", save.promise);
    edit("Unauthorized draft");
    await advance(800);
    edit("Queued after unauthorized draft");
    await settle(save, json({ success: false }, 401));
    expect(harness.auth().session.status).toBe("unauthenticated");
    expect(harness.capability.isCurrent()).toBe(false);
    expect(window.localStorage.getItem("token")).toBeNull();
    expect(harness.router.state.location.pathname).toBe(SESSION_ROUTE);
    await advance(800);
    await pagehide();
    await harness.unmountPage();
    expect(writes()).toHaveLength(1);
  });

  it.each([true, false])("locks editing only for a recognized 409 (%s)", async (recognized) => {
    const harness = await mountSession();
    expectSave("Conflict draft", json(recognized ? completedConflict : { success: false, message: "Generic conflict" }, 409));
    edit("Conflict draft");
    await advance(800);
    const answer = screen.getByRole("textbox");
    if (recognized) {
      expect(answer).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    } else {
      expect(answer).toBeEnabled();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expectSave("Conflict draft", json(saved), true);
    }
    expect(writes()).toHaveLength(1);
    await harness.unmountPage();
    expect(writes()).toHaveLength(recognized ? 1 : 2);
  });
});

describe("real capability-bound completion", () => {
  it("saves a dirty answer before completing and navigates on success", async () => {
    const { router } = await mountSession();
    const save = deferResponse();
    expectSave("Completion draft", save.promise);
    edit("Completion draft");
    await confirmCompletion();
    expect(writes()).toHaveLength(1);
    expect(router.state.location.pathname).toBe(SESSION_ROUTE);
    expectCompletion();
    await settle(save, json(saved));
    expect(writes()).toHaveLength(2);
    expect(router.state.location.pathname).toBe(RESULTS_ROUTE);
  });

  it.each(["replacement", "failed save"])("blocks completion after %s during a required save", async (scenario) => {
    const harness = await mountSession();
    const save = deferResponse();
    expectSave("Required draft", save.promise);
    edit("Required draft");
    await confirmCompletion();
    if (scenario === "replacement") {
      await verifyAccountReplacement(harness);
      await settle(save, json(saved));
    } else {
      await settle(save, json({ success: false }, 500));
      expect(screen.getByRole("alert")).toHaveTextContent("The authenticated request failed.");
      expectSave("Required draft", json(saved), true);
    }
    expect(writes()).toHaveLength(1);
    expect(harness.router.state.location.pathname).toBe(SESSION_ROUTE);
    await harness.unmountPage();
  });

  it("ignores successful completion from an earlier authentication generation", async () => {
    const harness = await mountSession();
    const completion = deferResponse();
    expectCompletion(completion.promise);
    await confirmCompletion();
    expect(writes()).toHaveLength(1);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving and submitting..." })).toBeDisabled();
    await verifyAccountReplacement(harness);
    await settle(completion, json(completed));
    expect(harness.router.state.location.pathname).toBe(SESSION_ROUTE);
    expect(screen.getByRole("button", { name: "Saving and submitting..." })).toBeDisabled();
    expect(screen.queryByText(/Completed session/)).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    expectAccountB(harness);
    await harness.unmountPage();
    expectRequest(SESSION_PATH, json(loaded), { token: TOKEN_B });
    await harness.mountBoundPage();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });
});

describe("real capability-bound interview controls", () => {
  it("creates only after the actual missing-session response is normalized", async () => {
    const { router } = await mountControls();
    expectRequest(LOOKUP_PATH, json(missingSession, 404));
    expectCreation();
    expectRequest(SESSION_PATH, json(loaded));
    await click("Start Mock Interview");
    expect(router.state.location.pathname).toBe(SESSION_ROUTE);
    expect(router.state.location.state).toEqual({ interviewId: INTERVIEW_ID });
  });

  it("resumes a session with the same capability and no creation request", async () => {
    const { router } = await mountControls(json(loaded));
    expectRequest(LOOKUP_PATH, json(loaded));
    expectRequest(SESSION_PATH, json(loaded));
    await click("Resume Mock Interview");
    expect(router.state.location.pathname).toBe(SESSION_ROUTE);
    expect(writes()).toHaveLength(0);
  });

  it.each(["Interview not found", "Generic missing resource"])("does not create after %s", async (message) => {
    const { router } = await mountControls();
    expectRequest(LOOKUP_PATH, json({ success: false, message }, 404));
    await click("Start Mock Interview");
    expect(screen.getByRole("alert")).toHaveTextContent("The authenticated request failed.");
    expect(router.state.location.pathname).toBe(INTERVIEW_ROUTE);
    expect(writes()).toHaveLength(0);
  });

  it.each(["lookup", "creation"])("rejects stale %s continuation after account replacement", async (operation) => {
    const harness = await mountControls();
    const pending = deferResponse();
    if (operation === "lookup") {
      expectRequest(LOOKUP_PATH, pending.promise);
    } else {
      expectRequest(LOOKUP_PATH, json(missingSession, 404));
      expectCreation(pending.promise);
    }
    await click("Start Mock Interview");
    await verifyAccountReplacement(harness);
    await settle(pending, operation === "lookup" ? json(missingSession, 404) : json(loaded, 201));
    expect(harness.router.state.location.pathname).toBe(INTERVIEW_ROUTE);
    expect(writes()).toHaveLength(operation === "lookup" ? 0 : 1);
    expectAccountB(harness);
  });
});

describe("real capability destination and cancellation guards", () => {
  it("rejects other origins and administrator destinations before any dispatch", async () => {
    const harness = await mountProvider();
    const capability = harness.auth().captureAuthenticatedRequest();
    for (const destination of ["https://example.test/api/mock-sessions/session-a", `${API}/admin/profile`]) {
      await expect(authenticatedRequest(capability, destination))
        .rejects.toMatchObject({ category: "invalid-destination" });
    }
    expect(actualRequests).toHaveLength(1);
  });

  it("does not expose normalized absence after the caller aborts", async () => {
    const harness = await mountProvider();
    const capability = harness.auth().captureAuthenticatedRequest();
    const controller = new AbortController();
    const response = deferResponse();
    expectRequest(LOOKUP_PATH, response.promise);
    const lookup = findInProgressMockSession(INTERVIEW_ID, { capability, signal: controller.signal });
    const rejected = expect(lookup).rejects.not.toHaveProperty("data");
    controller.abort();
    await settle(response, json(missingSession, 404));
    await rejected;
    await expect(lookup).rejects.toMatchObject({ category: "cancelled" });
    expect(capability.isCurrent()).toBe(true);
  });

  it("exposes only the expected frozen metadata for current 404 and 409 responses", async () => {
    const { auth } = await mountProvider();
    const capability = auth().captureAuthenticatedRequest();
    expectRequest(LOOKUP_PATH, json(missingSession, 404));
    expectSave("Conflict draft", json(completedConflict, 409));
    for (const [dispatch, status, errorCode] of [
      [() => findInProgressMockSession(INTERVIEW_ID, { capability }), 404, "no_in_progress_session"],
      [() => saveMockSessionAnswer(SESSION_ID, QUESTION_ID, "Conflict draft", { capability }), 409, "session_completed"],
    ]) {
      const request = dispatch();
      await expect(request).rejects.toMatchObject({ status, category: "http-error", data: { errorCode } });
      const error = await request.catch((failure) => failure);
      expect(error.data).toEqual({ errorCode });
      expect(Object.isFrozen(error.data)).toBe(true);
    }
  });

  it("discards recognized metadata if the account changes while reading the HTTP body", async () => {
    const harness = await mountProvider();
    const capability = harness.auth().captureAuthenticatedRequest();
    const response = json(missingSession, 404);
    const body = deferResponse();
    const read = vi.spyOn(response, "text").mockReturnValueOnce(body.promise);
    expectRequest(LOOKUP_PATH, response);
    const lookup = findInProgressMockSession(INTERVIEW_ID, { capability });
    const rejection = expect(lookup).rejects.toMatchObject({ category: "stale-session" });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    await verifyAccountReplacement({ ...harness, capability });
    await settle(body, JSON.stringify(missingSession));
    await rejection;
    await expect(lookup).rejects.not.toHaveProperty("data");
  });
});
