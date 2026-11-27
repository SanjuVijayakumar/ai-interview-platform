import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, MemoryRouter, RouterProvider } from "react-router-dom";
import InterviewsPage, { CapabilityBoundInterviewsPage } from "./InterviewsPage.jsx";
import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";
import { createInterview, deleteInterview, getInterviews, updateInterview } from "../services/interviewService.js";

vi.mock("../services/interviewService.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createInterview: vi.fn(actual.createInterview),
    deleteInterview: vi.fn(actual.deleteInterview),
    getInterviews: vi.fn(actual.getInterviews),
    updateInterview: vi.fn(actual.updateInterview),
  };
});

const interview = {
  _id: "interview-1",
  title: "Frontend Engineer",
  category: "Engineering",
  difficulty: "Intermediate",
  status: "completed",
  practiceStatus: "in-progress",
  createdAt: "2026-11-01T10:00:00.000Z",
};

function ReturnAfterSession() {
  return <Link to="/interviews">Return to My Interviews</Link>;
}

function renderPage() {
  const router = createMemoryRouter([
    { path: "/interviews", element: <InterviewsPage /> },
    { path: "/mock-session/:sessionId", element: <ReturnAfterSession /> },
  ], { initialEntries: ["/interviews"] });
  return { ...render(<RouterProvider router={router} />), router };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("InterviewsPage practice status", () => {
  beforeEach(() => {
    getInterviews.mockResolvedValue([interview]);
    createInterview.mockResolvedValue({ _id: "new-interview" });
    updateInterview.mockResolvedValue({ ...interview });
    deleteInterview.mockResolvedValue({});
  });
  it("uses practiceStatus for cards with consistent labels and styles", async () => {
    getInterviews.mockResolvedValue([
      { ...interview, _id: "scheduled", title: "Scheduled practice", status: "completed", practiceStatus: "scheduled" },
      { ...interview, _id: "active", title: "Active practice", status: "completed", practiceStatus: "in-progress" },
      { ...interview, _id: "done", title: "Completed practice", status: "scheduled", practiceStatus: "completed" },
    ]);
    renderPage();

    expect(await screen.findByText("Scheduled practice")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Scheduled")).toHaveClass("theme-status-warning");
    expect(screen.getByLabelText("Practice status: In Progress")).toHaveClass("theme-status-info");
    expect(screen.getByLabelText("Practice status: Completed")).toHaveClass("theme-status-success");
  });

  it.each([
    { practiceStatus: undefined, storedStatus: "completed" },
    { practiceStatus: "unknown", storedStatus: "in-progress" },
  ])("shows an unavailable label for missing or unknown practiceStatus", async ({ practiceStatus, storedStatus }) => {
    const item = { ...interview, status: storedStatus };
    if (practiceStatus !== undefined) item.practiceStatus = practiceStatus;
    else delete item.practiceStatus;
    getInterviews.mockResolvedValue([item]);
    renderPage();

    expect(await screen.findByText("Frontend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Practice status unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Practice status: Completed")).not.toBeInTheDocument();
  });

  it("keeps manual status in the edit form, excludes practiceStatus from PATCH, and reloads derived status", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockResolvedValueOnce([interview])
      .mockResolvedValueOnce([{ ...interview, status: "scheduled", practiceStatus: "completed" }]);
    updateInterview.mockResolvedValue({ ...interview, practiceStatus: "in-progress" });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const manualStatus = screen.getByLabelText(/Manual interview status/);
    expect(manualStatus).toHaveValue("completed");
    expect(screen.getByText("Manually managed; practice progress is calculated from mock sessions.")).toBeInTheDocument();
    await user.selectOptions(manualStatus, "scheduled");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(getInterviews).toHaveBeenCalledTimes(2));
    expect(updateInterview).toHaveBeenCalledWith("interview-1", {
      title: "Frontend Engineer",
      category: "Engineering",
      difficulty: "Intermediate",
      status: "scheduled",
    });
    expect(updateInterview.mock.calls[0][1]).not.toHaveProperty("practiceStatus");
    expect(screen.getByLabelText("Practice status: Completed")).toBeInTheDocument();
  });

  it("does not send practiceStatus when creating an interview", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...interview,
        _id: "new-interview",
        title: "New practice",
        status: "scheduled",
        practiceStatus: "scheduled",
      }]);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create your first interview" }));
    await user.type(screen.getByLabelText("Interview title"), "New practice");
    await user.type(screen.getByLabelText("Category"), "Engineering");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create interview" }));

    await waitFor(() => expect(getInterviews).toHaveBeenCalledTimes(2));
    expect(createInterview).toHaveBeenCalledWith({
      title: "New practice",
      category: "Engineering",
      difficulty: "Beginner",
    });
    expect(createInterview.mock.calls[0][0]).not.toHaveProperty("practiceStatus");
    expect(screen.getByLabelText("Practice status: Scheduled")).toBeInTheDocument();
  });

  it("refreshes practice status when returning after mock-session completion", async () => {
    const user = userEvent.setup();
    let interviewRequest = 0;
    getInterviews.mockImplementation(async () => {
      interviewRequest += 1;
      return [{ ...interview, practiceStatus: interviewRequest === 1 ? "in-progress" : "completed" }];
    });
    const { router } = renderPage();

    expect(await screen.findByLabelText("Practice status: In Progress")).toBeInTheDocument();
    await act(async () => { await router.navigate("/mock-session/session-1"); });
    await user.click(screen.getByRole("link", { name: "Return to My Interviews" }));

    expect(await screen.findByLabelText("Practice status: Completed")).toBeInTheDocument();
    expect(getInterviews).toHaveBeenCalledTimes(2);
  });
});

const api = "http://localhost:5000/api";
const interviewsPath = "/interviews";
const detailPath = `${interviewsPath}/${interview._id}`;
const profilePath = "/auth/profile";
const tokenA = "synthetic-interviews-token-a";
const tokenB = "synthetic-interviews-token-b";
const userA = { id: "a".repeat(24), name: "Alice Tests", email: "alice@example.test", role: "user" };
const userB = { id: "b".repeat(24), name: "Bob Tests", email: "bob@example.test", role: "user" };
const createPayload = { title: "New practice", category: "Engineering", difficulty: "Beginner" };
const updatePayload = { title: interview.title, category: interview.category, difficulty: interview.difficulty, status: "scheduled" };
const newInterview = { ...interview, ...createPayload, _id: "new-interview" };
const updatedInterview = { ...interview, ...updatePayload, practiceStatus: "completed" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function list(...interviews) {
  return json({ success: true, count: interviews.length, interviews });
}

function saved(record, status = 200) {
  return json({ success: true, interview: record }, status);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function click(name, scope = screen) {
  fireEvent.click(scope.getByRole("button", { name }));
}

function fillCreate(title = createPayload.title) {
  click("Create interview");
  fireEvent.change(screen.getByLabelText("Interview title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: createPayload.category } });
}

function submitForm() {
  fireEvent.submit(screen.getByRole("dialog").querySelector("form"));
}

function fillEdit() {
  click("Edit");
  expect(screen.getByLabelText(/Manual interview status/)).toHaveValue("completed");
  fireEvent.change(screen.getByLabelText(/Manual interview status/), { target: { value: "scheduled" } });
}

const mutations = [
  { action: "create", method: "POST", path: interviewsPath, payload: createPayload, prepare: fillCreate, dispatch: submitForm, response: () => saved(newInterview, 201) },
  { action: "update", method: "PATCH", path: detailPath, payload: updatePayload, prepare: fillEdit, dispatch: submitForm, response: () => saved(updatedInterview) },
  { action: "delete", method: "DELETE", path: detailPath, dispatch: () => click("Delete"), response: () => saved(interview) },
];

async function startMutation({ prepare, dispatch }) {
  prepare?.();
  await act(async () => dispatch());
}

describe("prepared InterviewsPage", () => {
  let capability;
  let logoutEvent;
  let confirm;

  beforeEach(() => {
    localStorage.setItem("token", tokenA);
    vi.spyOn(Storage.prototype, "getItem");
    vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(Storage.prototype, "clear");
    logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent);
    confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    capability = {
      isCurrent: vi.fn(() => true),
      fetch: vi.fn(() => { throw new Error("Unexpected capability request"); }),
    };
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected native fetch"); }));
  });

  afterEach(async () => {
    try {
      await act(async () => cleanup());
      expect(fetch).not.toHaveBeenCalled();
      for (const method of ["getItem", "removeItem", "setItem", "clear"]) {
        expect(Storage.prototype[method]).not.toHaveBeenCalled();
      }
      expect(logoutEvent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("prepx:logout", logoutEvent);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  const tree = (supplied) => (
    <MemoryRouter>
      <CapabilityBoundInterviewsPage capability={supplied} />
    </MemoryRouter>
  );

  async function mount(supplied = capability, strict = false) {
    const page = tree(supplied);
    let view;
    await act(async () => { view = render(strict ? <StrictMode>{page}</StrictMode> : page); });
    return view;
  }

  it.each([["missing", null], ["invalid", {}], ["stale", { isCurrent: () => false, fetch: vi.fn() }]])(
    "fails closed for a %s capability",
    async (_label, supplied) => {
      await mount(supplied);
      expect(screen.getByRole("alert")).toHaveTextContent("Your interview session is unavailable.");
      expect(getInterviews).not.toHaveBeenCalled();
      if (supplied?.fetch) expect(supplied.fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the list, filters, practice badge and detail link through ordinary rerenders", async () => {
    capability.fetch.mockResolvedValueOnce(list(interview, { ...newInterview, difficulty: "Advanced" }));
    const view = await mount();
    fireEvent.change(screen.getByLabelText("Filter by difficulty"), { target: { value: "Intermediate" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Frontend" } });
    expect(screen.getByLabelText("Practice status: In Progress")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Details" })).toHaveAttribute("href", detailPath);
    expect(screen.queryByText(newInterview.title)).not.toBeInTheDocument();
    await act(async () => view.rerender(tree(capability)));
    expect(screen.getByRole("searchbox")).toHaveValue("Frontend");
    expect(capability.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a replacement capability within the same mount and cancels the originating read", async () => {
    const pending = deferred();
    capability.fetch.mockReturnValueOnce(pending.promise);
    const view = await mount();
    const next = { isCurrent: () => true, fetch: vi.fn() };
    await act(async () => view.rerender(tree(next)));
    expect(capability.fetch.mock.lastCall[1].signal.aborted).toBe(true);
    await act(async () => pending.resolve(list(interview)));
    expect(screen.getByRole("alert")).toHaveTextContent("Your interview session is unavailable.");
    expect(next.fetch).not.toHaveBeenCalled();
  });

  it.each(mutations)("rejects duplicate $action before the pending request settles", async ({
    action, method, path, payload, prepare, response,
  }) => {
    const pending = deferred();
    capability.fetch.mockResolvedValueOnce(list(interview)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(list());
    await mount();
    prepare?.();
    await act(async () => {
      if (action === "delete") {
        const button = screen.getByRole("button", { name: "Delete" });
        fireEvent.click(button);
        fireEvent.click(button);
      } else {
        submitForm();
        submitForm();
      }
    });
    expect(capability.fetch).toHaveBeenCalledTimes(2);
    const signal = capability.fetch.mock.calls[1][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(capability.fetch.mock.calls[1]).toEqual([
      api + path, payload
        ? { method, signal, body: JSON.stringify(payload), headers: new Headers({ "Content-Type": "application/json" }) }
        : { method, signal },
    ]);
    if (action === "delete") expect(confirm).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(response()));
    expect(screen.getByText("Your practice starts here")).toBeInTheDocument();
    expect(getInterviews.mock.calls).toEqual([
      [{ capability, signal: expect.any(AbortSignal) }],
      [{ capability, signal: expect.any(AbortSignal) }],
    ]);
    expect(capability.fetch).toHaveBeenCalledTimes(3);
  });

  it("validates the form and respects cancelled delete confirmation", async () => {
    capability.fetch.mockResolvedValueOnce(list(interview));
    await mount();
    confirm.mockReturnValue(false);
    click("Delete");
    fillCreate(" ");
    submitForm();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an interview title and category.");
    expect(capability.fetch).toHaveBeenCalledOnce();
  });

  it.each(["network", "malformed", "refresh"])("offers a read-only recovery after a %s failure", async (mode) => {
    capability.fetch.mockResolvedValueOnce(list());
    if (mode === "network") {
      capability.fetch.mockRejectedValueOnce(Object.assign(new Error("private failure"), { category: "network-error" }));
    } else if (mode === "malformed") capability.fetch.mockResolvedValueOnce(json({ success: true }, 201));
    else capability.fetch.mockResolvedValueOnce(saved(newInterview, 201)).mockResolvedValueOnce(json({}, 503));
    capability.fetch.mockResolvedValueOnce(list(newInterview));
    await mount();
    fillCreate();
    await act(async () => submitForm());
    if (mode === "refresh") {
      expect(screen.getByText("Interview created.")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Your change succeeded, but the interview list couldn't be refreshed.");
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent("couldn't confirm whether the interview was saved");
      expect(screen.queryByText("Interview created.")).not.toBeInTheDocument();
    }
    expect(capability.fetch.mock.calls.map(([, options]) => options.method)).toEqual(
      mode === "refresh" ? ["GET", "POST", "GET"] : ["GET", "POST"],
    );
    await act(async () => click("Reload interviews"));
    expect(screen.getByText(newInterview.title)).toBeInTheDocument();
    expect(capability.fetch.mock.lastCall[1].method).toBe("GET");
  });

  it("supersedes an older list read and ignores its late response", async () => {
    const initial = deferred();
    capability.fetch.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(saved(newInterview, 201))
      .mockResolvedValueOnce(list(newInterview));
    await mount();
    fillCreate();
    await act(async () => submitForm());
    expect(capability.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => initial.resolve(list(interview)));
    expect(screen.getByText(newInterview.title)).toBeInTheDocument();
    expect(screen.queryByText(interview.title)).not.toBeInTheDocument();
    expect(capability.fetch).toHaveBeenCalledTimes(3);
  });

  it("leaves authentication termination to the boundary and skips the follow-up read", async () => {
    capability.fetch.mockResolvedValueOnce(list())
      .mockRejectedValueOnce(Object.assign(new Error("private failure"), { category: "unauthorized", status: 401 }));
    await mount();
    await startMutation(mutations[0]);
    expect(screen.getByRole("heading", { name: "My interviews" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(capability.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh signal on StrictMode replay and aborts pending requests on unmount", async () => {
    const first = deferred();
    const second = deferred();
    capability.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = await mount(capability, true);
    expect(capability.fetch).toHaveBeenCalledOnce();
    const firstSignal = capability.fetch.mock.lastCall[1].signal;
    expect(firstSignal.aborted).toBe(false);
    await act(async () => view.unmount());
    expect(firstSignal.aborted).toBe(true);
    const nextView = await mount(capability, true);
    const secondSignal = capability.fetch.mock.lastCall[1].signal;
    expect(secondSignal.aborted).toBe(false);
    expect(secondSignal).not.toBe(firstSignal);
    await act(async () => nextView.unmount());
    expect(secondSignal.aborted).toBe(true);
    await act(async () => { first.resolve(list(interview)); second.resolve(json({}, 401)); });
    expect(capability.fetch).toHaveBeenCalledTimes(2);
  });
});

function AuthProbe({ report }) {
  const auth = useAuth();
  useEffect(() => { report(auth); }, [auth, report]);
  return null;
}

describe("InterviewsPage with the real protected session boundary", () => {
  let planned;
  let requests;
  let logoutEvent;

  beforeEach(() => {
    localStorage.setItem("token", tokenA);
    planned = [];
    requests = [];
    logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const actual = {
        url: String(url),
        method: options.method ?? "GET",
        authorization: new Headers(options.headers).get("Authorization"),
        body: options.body,
      };
      const next = planned[requests.length];
      requests.push({ actual, signal: options.signal });
      if (!next || Object.keys(actual).some((key) => next.expected[key] !== actual[key])) {
        throw new Error(`Unexpected interview request: ${actual.method} ${actual.url}`);
      }
      return next.response;
    }));
  });

  afterEach(async () => {
    try {
      await act(async () => cleanup());
      expect(requests.map(({ actual }) => actual)).toEqual(planned.map(({ expected }) => expected));
    } finally {
      window.removeEventListener("prepx:logout", logoutEvent);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  function plan(path, response, { token = tokenA, method = "GET", payload } = {}) {
    planned.push({
      expected: { url: api + path, method, authorization: `Bearer ${token}`, body: JSON.stringify(payload) },
      response,
    });
  }

  function identity(user = userA) {
    return json({ success: true, user });
  }

  async function mount() {
    let auth;
    const report = (value) => { auth = value; };
    const router = createMemoryRouter([
      {
        path: "/interviews",
        element: (
          <ProtectedSessionBoundary>
            {({ capability }) => <CapabilityBoundInterviewsPage capability={capability} />}
          </ProtectedSessionBoundary>
        ),
      },
      { path: "/login", element: <p>Login route</p> },
    ], { initialEntries: ["/interviews"] });
    let view;
    await act(async () => {
      view = render(
        <AuthProvider>
          <AuthProbe report={report} />
          <RouterProvider router={router} />
        </AuthProvider>,
      );
    });
    return { auth: () => auth, router, unmount: view.unmount };
  }

  function planInitial() {
    plan(profilePath, identity());
    plan(interviewsPath, list(interview));
  }

  it.each(mutations)("verifies identity and binds $action and refresh to the originating bearer", async (mutation) => {
    const { action, method, path, payload, response } = mutation;
    const profile = deferred();
    plan(profilePath, profile.promise);
    await mount();
    expect(requests).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "My interviews" })).not.toBeInTheDocument();
    plan(interviewsPath, list(interview));
    await act(async () => profile.resolve(identity()));
    plan(path, response(), { method, payload });
    plan(interviewsPath, action === "delete" ? list() : list(action === "create" ? newInterview : updatedInterview));
    await startMutation(mutation);
    const verb = { create: "created", update: "updated", delete: "deleted" }[action];
    expect(screen.getByText(`Interview ${verb}.`)).toBeInTheDocument();
    expect(requests.slice(1).map(({ actual }) => actual.authorization)).toEqual([
      `Bearer ${tokenA}`, `Bearer ${tokenA}`, `Bearer ${tokenA}`,
    ]);
    expect(requests.slice(1).every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    if (action === "update") expect(screen.getByLabelText("Practice status: Completed")).toBeInTheDocument();
  });

  it.each([200, 503])("keeps an unsaved form, filters, and list during background verification (HTTP %i)", async (status) => {
    planInitial();
    const { auth } = await mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Frontend" } });
    fireEvent.change(screen.getByLabelText("Filter by difficulty"), { target: { value: "Intermediate" } });
    fillCreate("Unsaved practice");
    const form = screen.getByRole("dialog");
    const profile = deferred();
    plan(profilePath, profile.promise);
    await act(async () => { void auth().verifySession(); });
    expect(auth().session.isRevalidating).toBe(true);
    expect(screen.getByRole("dialog")).toBe(form);
    await act(async () => profile.resolve(status === 200 ? identity() : json({}, status)));
    expect(auth().session.status).toBe("authenticated");
    expect(screen.getByRole("dialog")).toBe(form);
    expect(screen.getByLabelText("Interview title")).toHaveValue("Unsaved practice");
    expect(screen.getByRole("searchbox")).toHaveValue("Frontend");
    expect(screen.getByLabelText("Filter by difficulty")).toHaveValue("Intermediate");
    expect(screen.getByText(interview.title)).toBeInTheDocument();
    expect(requests).toHaveLength(3);
  });

  it.each(mutations)("cancels pending $action on logout without refreshing", async (mutation) => {
    const { path, method, payload, response } = mutation;
    planInitial();
    const pending = deferred();
    plan(path, pending.promise, { method, payload });
    const { auth, router } = await mount();
    await startMutation(mutation);
    const signal = requests.at(-1).signal;
    await act(async () => auth().logout());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByText("Login route")).toBeInTheDocument();
    expect(logoutEvent).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(3);
  });

  it.each([
    ["cross-tab", 401], ["different user", 201], ["same user", 503], ["same token", 201],
  ])("isolates a pending write after %s replacement (old HTTP %i)", async (replacement, status) => {
    planInitial();
    const old = deferred();
    plan(interviewsPath, old.promise, { method: "POST", payload: createPayload });
    const { auth, router } = await mount();
    await startMutation(mutations[0]);
    const oldSignal = requests.at(-1).signal;
    const nextToken = replacement === "same token" ? tokenA : tokenB;
    const nextUser = replacement.startsWith("same") ? userA : userB;
    const replacementInterview = { ...interview, title: "Replacement account interview" };
    plan(profilePath, identity(nextUser), { token: nextToken });
    plan(interviewsPath, list(replacementInterview), { token: nextToken });
    await act(async () => {
      localStorage.setItem("token", nextToken);
      if (replacement === "cross-tab") {
        window.dispatchEvent(new StorageEvent("storage", {
          key: "token", oldValue: tokenA, newValue: nextToken, storageArea: localStorage,
        }));
      } else await auth().completeLogin();
    });
    expect(oldSignal.aborted).toBe(true);
    expect(auth().session.user).toEqual(nextUser);
    expect(screen.getByText(replacementInterview.title)).toBeInTheDocument();
    const next = deferred();
    plan(interviewsPath, next.promise, { token: nextToken, method: "POST", payload: createPayload });
    await startMutation(mutations[0]);
    await act(async () => old.resolve(status === 201 ? saved(newInterview, status) : json({}, status)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Interview title")).toHaveValue(createPayload.title);
    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
    await act(async () => submitForm());
    expect(requests).toHaveLength(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Interview created.")).not.toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe(nextToken);
    expect(logoutEvent).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/interviews");
    plan(interviewsPath, list(newInterview), { token: nextToken });
    await act(async () => next.resolve(saved(newInterview, 201)));
    expect(screen.getByText("Interview created.")).toBeInTheDocument();
  });

  it.each([401, 403])("preserves provider ownership on HTTP %i", async (status) => {
    planInitial();
    plan(detailPath, json({ message: "private backend message" }, status), { method: "DELETE" });
    const { auth, router } = await mount();
    await act(async () => click("Delete"));
    if (status === 401) {
      expect(auth().session.status).toBe("unauthenticated");
      expect(localStorage.getItem("token")).toBeNull();
      expect(logoutEvent).toHaveBeenCalledOnce();
      expect(router.state.location.pathname).toBe("/login");
    } else {
      expect(auth().session.status).toBe("authenticated");
      expect(localStorage.getItem("token")).toBe(tokenA);
      expect(logoutEvent).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to delete this interview.");
      expect(screen.getByText(interview.title)).toBeInTheDocument();
    }
  });

  it("discards an in-flight post-write refresh on authentication replacement", async () => {
    planInitial();
    const refresh = deferred();
    plan(interviewsPath, saved(newInterview, 201), { method: "POST", payload: createPayload });
    plan(interviewsPath, refresh.promise);
    const { auth } = await mount();
    await startMutation(mutations[0]);
    expect(screen.getByText("Interview created.")).toBeInTheDocument();
    const refreshSignal = requests.at(-1).signal;
    const replacement = { ...interview, title: "Fresh account list" };
    plan(profilePath, identity(userB), { token: tokenB });
    plan(interviewsPath, list(replacement), { token: tokenB });
    await act(async () => {
      localStorage.setItem("token", tokenB);
      await auth().completeLogin();
    });
    expect(refreshSignal.aborted).toBe(true);
    expect(screen.getByText(replacement.title)).toBeInTheDocument();
    await act(async () => refresh.resolve(list(newInterview)));
    expect(screen.getByText(replacement.title)).toBeInTheDocument();
    expect(screen.queryByText(newInterview.title)).not.toBeInTheDocument();
    expect(screen.queryByText("Interview created.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading your interviews/)).not.toBeInTheDocument();
  });

  it("aborts a mutation on provider unmount and leaves stored authentication alone", async () => {
    planInitial();
    const pending = deferred();
    plan(detailPath, pending.promise, { method: "DELETE" });
    const { unmount, router } = await mount();
    await act(async () => click("Delete"));
    const signal = requests.at(-1).signal;
    await act(async () => unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(json({}, 401)));
    expect(localStorage.getItem("token")).toBe(tokenA);
    expect(logoutEvent).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/interviews");
  });
});
