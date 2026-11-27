import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, MemoryRouter, RouterProvider } from "react-router-dom";
import DashboardPage, { CapabilityBoundDashboardPage } from "./DashboardPage.jsx";
import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";
import { logoutUser } from "../services/authService.js";
import { getDashboardStats } from "../services/dashboardService.js";
import { getInterviews } from "../services/interviewService.js";

vi.mock("../services/authService.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logoutUser: vi.fn(actual.logoutUser) };
});
vi.mock("../services/dashboardService.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDashboardStats: vi.fn(actual.getDashboardStats) };
});
vi.mock("../services/interviewService.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getInterviews: vi.fn(actual.getInterviews) };
});

const defaultStats = {
  totalInterviews: 4,
  completedInterviews: 2,
  pendingInterviews: 2,
  averageScore: 87.6,
};

function ReturnToDashboard() {
  return <Link to="/dashboard">Return to Dashboard</Link>;
}

function renderDashboard() {
  const router = createMemoryRouter([
    { path: "/dashboard", element: <DashboardPage /> },
    { path: "/mock-session/:sessionId", element: <ReturnToDashboard /> },
    { path: "/login", element: <p>Login route</p> },
    { path: "/interviews", element: <p>Interviews route</p> },
  ], { initialEntries: ["/dashboard"] });
  return { ...render(<RouterProvider router={router} />), router };
}

function cardValue(label) {
  return within(screen.getByText(label).closest("article")).getByText(/^(?:\d+(?:\.\d+)?|—|…)$/);
}

function makeInterview(id, title, createdAt, status = "scheduled", practiceStatus) {
  const interview = {
    _id: id,
    title,
    category: "Engineering",
    difficulty: "Intermediate",
    createdAt,
    status,
  };
  if (practiceStatus !== undefined) interview.practiceStatus = practiceStatus;
  return interview;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("DashboardPage", () => {
  beforeEach(() => {
    logoutUser.mockImplementation(() => {});
    getDashboardStats.mockResolvedValue(defaultStats);
    getInterviews.mockResolvedValue([]);
  });

  it("renders backend statistics and preserves recent-interview sorting", async () => {
    getDashboardStats.mockResolvedValue({
      totalInterviews: 8,
      completedInterviews: 2,
      pendingInterviews: 6,
      averageScore: 87.56,
    });
    getInterviews.mockResolvedValue([
      makeInterview("older", "Older session", "2026-10-01T10:00:00.000Z", "scheduled", "completed"),
      makeInterview("newest", "Newest session", "2026-11-01T10:00:00.000Z", "completed", "scheduled"),
      makeInterview("middle", "Middle session", "2026-10-15T10:00:00.000Z", "scheduled", "in-progress"),
    ]);

    renderDashboard();

    expect(await screen.findByText("Newest session")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("8");
    expect(cardValue("Completed interviews")).toHaveTextContent("2");
    expect(cardValue("Pending interviews")).toHaveTextContent("6");
    expect(cardValue("Average score")).toHaveTextContent("87.6");

    const recentTitles = screen.getByRole("heading", { name: "Recent interviews" })
      .closest("section")
      .querySelectorAll("article h3");
    expect([...recentTitles].map((heading) => heading.textContent)).toEqual([
      "Newest session", "Middle session", "Older session",
    ]);
    expect(screen.getByLabelText("Practice status: Scheduled")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: In Progress")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Completed")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Scheduled")).toHaveClass("theme-status-warning");
    expect(screen.getByLabelText("Practice status: Completed")).toHaveClass("theme-status-success");
  });

  it.each([
    { practiceStatus: undefined, storedStatus: "completed" },
    { practiceStatus: "unknown", storedStatus: "in-progress" },
  ])("does not present stored status as practice progress when practiceStatus is $practiceStatus", async ({ practiceStatus, storedStatus }) => {
    getInterviews.mockResolvedValue([
      makeInterview("unknown", "Unverified practice status", "2026-11-01T10:00:00.000Z", storedStatus, practiceStatus),
    ]);
    renderDashboard();

    expect(await screen.findByText("Unverified practice status")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Practice status unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Practice status: Completed")).not.toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("4");
    expect(cardValue("Average score")).toHaveTextContent("87.6");
  });

  it.each([
    { averageScore: null, display: "—" },
    { averageScore: 0, display: "0" },
  ])("formats average score $averageScore as $display", async ({ averageScore, display }) => {
    getDashboardStats.mockResolvedValue({ ...defaultStats, averageScore });
    renderDashboard();

    expect(await screen.findByText(display, { selector: "p" })).toBeInTheDocument();
    expect(cardValue("Average score")).toHaveTextContent(display);
  });

  it("shows statistics loading independently while recent interviews load", async () => {
    const pendingStats = deferred();
    getDashboardStats.mockReturnValue(pendingStats.promise);
    getInterviews.mockResolvedValue([
      makeInterview("recent", "Available recent interview", "2026-11-01T10:00:00.000Z"),
    ]);
    renderDashboard();

    expect(await screen.findByText("Available recent interview")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("…");
    expect(within(screen.getByText("Total interviews").closest("article")).getByText("Loading your statistics")).toBeInTheDocument();
    pendingStats.resolve(defaultStats);
    await waitFor(() => expect(cardValue("Total interviews")).toHaveTextContent("4"));
  });

  it("shows a statistics error without hiding recent interviews and retries only statistics", async () => {
    const user = userEvent.setup();
    getDashboardStats
      .mockRejectedValueOnce(new Error("Statistics unavailable"))
      .mockResolvedValueOnce(defaultStats);
    getInterviews.mockResolvedValue([
      makeInterview("recent", "Recent interview remains visible", "2026-11-01T10:00:00.000Z"),
    ]);
    renderDashboard();

    expect(await screen.findByText("Statistics unavailable")).toBeInTheDocument();
    expect(screen.getByText("Recent interview remains visible")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("—");
    await user.click(screen.getByRole("button", { name: "Retry statistics" }));

    await waitFor(() => expect(cardValue("Total interviews")).toHaveTextContent("4"));
    expect(getDashboardStats).toHaveBeenCalledTimes(2);
    expect(getInterviews).toHaveBeenCalledTimes(1);
  });

  it("shows a recent-interviews error without hiding statistics and retries only interviews", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockRejectedValueOnce(new Error("Interview history unavailable"))
      .mockResolvedValueOnce([
        makeInterview("recent", "Interview history recovered", "2026-11-01T10:00:00.000Z"),
      ]);
    renderDashboard();

    expect(await screen.findByText("Interview history unavailable")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("4");
    await user.click(screen.getByRole("button", { name: "Reload interviews" }));

    expect(await screen.findByText("Interview history recovered")).toBeInTheDocument();
    expect(getInterviews).toHaveBeenCalledTimes(2);
    expect(getDashboardStats).toHaveBeenCalledTimes(1);
  });

  it("refreshes practice status after returning from a completed mock session without changing statistics", async () => {
    const user = userEvent.setup();
    let interviewRequest = 0;
    getInterviews.mockImplementation(async () => {
      interviewRequest += 1;
      return [makeInterview(
        "practice",
        "Practice interview",
        "2026-11-01T10:00:00.000Z",
        "scheduled",
        interviewRequest === 1 ? "in-progress" : "completed",
      )];
    });
    const { router } = renderDashboard();

    expect(await screen.findByLabelText("Practice status: In Progress")).toBeInTheDocument();
    await act(async () => { await router.navigate("/mock-session/session-1"); });
    await user.click(screen.getByRole("link", { name: "Return to Dashboard" }));

    expect(await screen.findByLabelText("Practice status: Completed")).toBeInTheDocument();
    expect(getInterviews).toHaveBeenCalledTimes(2);
    expect(cardValue("Completed interviews")).toHaveTextContent("2");
    expect(cardValue("Average score")).toHaveTextContent("87.6");
    expect(getDashboardStats).toHaveBeenCalledTimes(2);
  });

  it("redirects to login and logs out when either request is unauthorized", async () => {
    getDashboardStats.mockRejectedValueOnce(Object.assign(new Error("Access denied"), { status: 401 }));
    renderDashboard();

    expect(await screen.findByText("Login route")).toBeInTheDocument();
    expect(logoutUser).toHaveBeenCalledTimes(1);
  });
});

const api = "http://localhost:5000/api";
const statsPath = "/dashboard/stats";
const listPath = "/interviews";
const profilePath = "/auth/profile";
const tokenA = "synthetic-dashboard-token-a";
const tokenB = "synthetic-dashboard-token-b";
const userA = { id: "a".repeat(24), name: "Alice Example", email: "alice@example.test", role: "user" };
const userB = { id: "b".repeat(24), name: "Bob Example", email: "bob@example.test", role: "user" };
const statsError = "We couldn't load your dashboard statistics. Please try again.";
const listError = "We couldn't load your interviews. Please try again.";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function interviewList(...interviews) {
  return json({ success: true, count: interviews.length, interviews });
}

function recentInterview(title) {
  return makeInterview("recent", title, "2026-11-01T10:00:00.000Z", "scheduled", "completed");
}

function dashboardRouter(element) {
  return createMemoryRouter([
    { path: "/dashboard", element },
    { path: "/login", element: <p>Login route</p> },
    { path: "/interviews", element: <p>Interviews route</p> },
  ], { initialEntries: ["/dashboard"] });
}

describe("CapabilityBoundDashboardPage", () => {
  let storageRead;
  let storageWrite;
  let storageRemove;
  let logoutEvent;

  beforeEach(() => {
    localStorage.setItem("token", tokenA);
    storageRead = vi.spyOn(Storage.prototype, "getItem");
    storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageRemove = vi.spyOn(Storage.prototype, "removeItem");
    logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected native fetch"); }));
  });

  afterEach(async () => {
    try {
      await act(async () => cleanup());
      expect(fetch).not.toHaveBeenCalled();
      expect(storageRead).not.toHaveBeenCalled();
      expect(storageWrite).not.toHaveBeenCalled();
      expect(storageRemove).not.toHaveBeenCalled();
      expect(logoutEvent).not.toHaveBeenCalled();
      expect(logoutUser).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("prepx:logout", logoutEvent);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  async function mount(capability, { strict = false } = {}) {
    const router = dashboardRouter(<CapabilityBoundDashboardPage capability={capability} />);
    // Router construction reads its own transition cache before the page mounts.
    storageRead.mockClear();
    const page = <RouterProvider router={router} />;
    let view;
    await act(async () => { view = render(strict ? <StrictMode>{page}</StrictMode> : page); });
    return { ...view, router };
  }

  it.each([0, null])("binds both reads to one capability and renders average %s", async (averageScore) => {
    const capability = {
      isCurrent: () => true,
      fetch: vi.fn()
        .mockResolvedValueOnce(json({ ...defaultStats, averageScore }))
        .mockResolvedValueOnce(averageScore === 0 ? interviewList(recentInterview("Bound interview")) : interviewList()),
    };
    const { router } = await mount(capability);
    const [{ signal: statsSignal }] = getDashboardStats.mock.lastCall;
    const [{ signal: listSignal }] = getInterviews.mock.lastCall;
    expect(getDashboardStats).toHaveBeenCalledExactlyOnceWith({ capability, signal: statsSignal });
    expect(getInterviews).toHaveBeenCalledExactlyOnceWith({ capability, signal: listSignal });
    expect(capability.fetch.mock.calls).toEqual([
      [api + statsPath, { method: "GET", signal: statsSignal }],
      [api + listPath, { method: "GET", signal: listSignal }],
    ]);
    expect(statsSignal).toBeInstanceOf(AbortSignal);
    expect(listSignal).toBeInstanceOf(AbortSignal);
    expect(statsSignal).not.toBe(listSignal);
    expect(cardValue("Average score")).toHaveTextContent(averageScore === null ? "—" : "0");
    if (averageScore === 0) {
      expect(screen.getByText("Bound interview")).toBeInTheDocument();
      expect(screen.getByLabelText("Practice status: Completed")).toBeInTheDocument();
      expect(screen.queryByLabelText("Practice status: Scheduled")).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("Your interview history starts here")).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/interviews");
    await userEvent.click(screen.getByRole("link", { name: "Start new interview" }));
    expect(router.state.location.pathname).toBe("/interviews");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", { fetch: vi.fn() }],
    ["callable", () => { throw new Error("An invalid capability must never be called"); }],
    ["stale", { fetch: vi.fn(), isCurrent: () => false }],
  ])("fails closed for a %s capability", async (_label, capability) => {
    await mount(capability);
    expect(screen.getByRole("alert")).toHaveTextContent("Your dashboard session is unavailable.");
    expect(getDashboardStats).not.toHaveBeenCalled();
    expect(getInterviews).not.toHaveBeenCalled();
    if (capability?.fetch) expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("retains the originating capability on ordinary rerenders and rejects replacement props", async () => {
    const stats = deferred();
    const interviews = deferred();
    const capability = { isCurrent: () => true, fetch: vi.fn().mockReturnValueOnce(stats.promise).mockReturnValueOnce(interviews.promise) };
    const replacement = { isCurrent: () => true, fetch: vi.fn() };
    const tree = (supplied, name) => (
      <MemoryRouter><CapabilityBoundDashboardPage capability={supplied} user={{ name }} /></MemoryRouter>
    );
    const view = render(tree(capability, "Alice"));
    await act(async () => view.rerender(tree(capability, "Alice Updated")));
    expect(capability.fetch).toHaveBeenCalledTimes(2);
    await act(async () => view.rerender(tree(replacement, "Bob")));
    expect(screen.getByRole("alert")).toHaveTextContent("Your dashboard session is unavailable.");
    expect(replacement.fetch).not.toHaveBeenCalled();
    expect(capability.fetch.mock.calls.every(([, { signal }]) => signal.aborted)).toBe(true);
    await act(async () => {
      stats.resolve(json({ ...defaultStats, totalInterviews: 42 }));
      interviews.resolve(interviewList(recentInterview("Obsolete interview")));
    });
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(screen.queryByText("Obsolete interview")).not.toBeInTheDocument();
  });

  it.each([
    ["statistics", 403], ["interviews", 503], ["statistics", "network"],
    ["interviews", "malformed"], ["statistics", "body failure"],
  ])("keeps the other section usable after a %s failure (%s) and retries only on click", async (section, outcome) => {
    const failure = () => {
      if (outcome === "network") {
        return Promise.reject(Object.assign(new Error("private network failure"), { category: "network-error" }));
      }
      if (outcome === "malformed") return new Response("{private invalid JSON");
      if (outcome === "body failure") {
        return { ok: true, status: 200, text: async () => { throw new Error("private body failure"); } };
      }
      return json({ message: "private backend failure" }, outcome);
    };
    const list = () => interviewList(recentInterview("Available interview"));
    const stats = () => json(defaultStats);
    const capability = {
      isCurrent: () => true,
      fetch: vi.fn()
        .mockImplementationOnce(section === "statistics" ? failure : stats)
        .mockImplementationOnce(section === "interviews" ? failure : list)
        .mockImplementationOnce(section === "statistics" ? stats : list),
    };
    const { router } = await mount(capability);
    expect(router.state.location.pathname).toBe("/dashboard");
    expect(screen.getByRole("alert")).toHaveTextContent(section === "statistics" ? statsError : listError);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    if (section === "statistics") expect(screen.getByText("Available interview")).toBeInTheDocument();
    else expect(cardValue("Total interviews")).toHaveTextContent("4");
    expect(capability.fetch).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", {
      name: section === "statistics" ? "Retry statistics" : "Reload interviews",
    }));
    expect(capability.fetch).toHaveBeenCalledTimes(3);
    expect(capability.fetch.mock.lastCall[0]).toBe(api + (section === "statistics" ? statsPath : listPath));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores provider unauthorized errors without logout or login navigation", async () => {
    const capability = {
      isCurrent: () => true,
      fetch: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("private denial"), { category: "unauthorized", status: 401 }))
        .mockResolvedValueOnce(interviewList(recentInterview("Independent interview"))),
    };
    const { router } = await mount(capability);
    expect(router.state.location.pathname).toBe("/dashboard");
    expect(screen.getByText("Independent interview")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses fresh signals after StrictMode replay and cancels the active reads on unmount", async () => {
    const obsoleteStats = deferred();
    const obsoleteList = deferred();
    const activeList = deferred();
    const capability = {
      isCurrent: () => true,
      fetch: vi.fn()
        .mockReturnValueOnce(obsoleteStats.promise)
        .mockReturnValueOnce(obsoleteList.promise)
        .mockResolvedValueOnce(json(defaultStats))
        .mockReturnValueOnce(activeList.promise),
    };
    const { router, unmount } = await mount(capability, { strict: true });
    const signals = capability.fetch.mock.calls.map(([, { signal }]) => signal);
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true, false, false]);
    expect(cardValue("Total interviews")).toHaveTextContent("4");
    await act(async () => unmount());
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
    await act(async () => {
      obsoleteStats.resolve(json({ ...defaultStats, totalInterviews: 99 }));
      obsoleteList.resolve(interviewList(recentInterview("Obsolete interview")));
      activeList.resolve(json({}, 401));
    });
    expect(router.state.location.pathname).toBe("/dashboard");
    expect(screen.queryByText("Obsolete interview")).not.toBeInTheDocument();
  });
});

function AuthProbe({ report }) {
  const auth = useAuth();
  useEffect(() => { report(auth); }, [auth, report]);
  return null;
}

describe("Dashboard with the real protected session boundary", () => {
  let expected;
  let requests;
  let logoutEvent;

  beforeEach(() => {
    localStorage.setItem("token", tokenA);
    expected = [];
    requests = [];
    logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent);
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const actual = {
        url: String(url),
        authorization: new Headers(options.headers).get("Authorization"),
        method: options.method ?? "GET",
        redirect: options.redirect,
      };
      const next = expected[requests.length];
      requests.push({ actual, signal: options.signal });
      if (!next || Object.keys(actual).some((key) => actual[key] !== next.request[key])) {
        throw new Error(`Unexpected dashboard HTTP request: ${actual.method} ${actual.url}`);
      }
      return next.response;
    }));
  });

  afterEach(async () => {
    try {
      await act(async () => cleanup());
      expect(requests.map(({ actual }) => actual)).toEqual(expected.map(({ request }) => request));
    } finally {
      window.removeEventListener("prepx:logout", logoutEvent);
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  function expectRequest(path, response, token = tokenA) {
    expected.push({
      request: {
        url: api + path,
        authorization: `Bearer ${token}`,
        method: "GET",
        redirect: "error",
      },
      response,
    });
  }

  function identity(user = userA) {
    return json({ success: true, user });
  }

  function expectDashboard({ token = tokenA, stats = json(defaultStats), interviews = interviewList() } = {}) {
    expectRequest(statsPath, stats, token);
    expectRequest(listPath, interviews, token);
  }

  async function mount() {
    let auth;
    const report = (value) => { auth = value; };
    const router = dashboardRouter(
      <ProtectedSessionBoundary>
        {({ capability }) => <CapabilityBoundDashboardPage capability={capability} />}
      </ProtectedSessionBoundary>,
    );
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

  it("verifies identity before dispatching either dashboard read with the originating bearer", async () => {
    const profile = deferred();
    expectRequest(profilePath, profile.promise);
    const { auth } = await mount();
    expect(requests).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Verifying your session");
    expect(screen.queryByText("Your progress")).not.toBeInTheDocument();
    expectDashboard({ interviews: interviewList(recentInterview("Alice interview")) });
    await act(async () => profile.resolve(identity()));
    expect(auth().session.user).toEqual(userA);
    expect(screen.getByText("Alice interview")).toBeInTheDocument();
    expect(requests.slice(1).map(({ actual }) => actual.authorization)).toEqual([
      `Bearer ${tokenA}`, `Bearer ${tokenA}`,
    ]);
    expect(requests.slice(1).every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
  });

  it.each([[200, false], [200, true], [503, false], [503, true]])(
    "preserves the dashboard during background verification (%i, existing list error: %s)",
    async (status, hasListError) => {
      expectRequest(profilePath, identity());
      expectDashboard({
        interviews: hasListError
          ? json({ message: "private resource failure" }, 403)
          : interviewList(recentInterview("Existing interview")),
      });
      const { auth, router } = await mount();
      const originalUser = auth().session.user;
      const heading = screen.getByRole("heading", { name: "Your progress" });
      const listContent = hasListError ? screen.getByRole("alert") : screen.getByText("Existing interview");
      if (hasListError) expect(listContent).toHaveTextContent(listError);
      const verification = deferred();
      expectRequest(profilePath, verification.promise);
      await act(async () => { void auth().verifySession(); });
      expect(auth().session.isRevalidating).toBe(true);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      await act(async () => verification.resolve(status === 200 ? identity() : json({}, status)));
      expect(auth().session.status).toBe("authenticated");
      if (status === 200) expect(auth().session.user).not.toBe(originalUser);
      else expect(auth().session.error?.category).toBe("service-unavailable");
      expect(screen.getByRole("heading", { name: "Your progress" })).toBe(heading);
      expect(hasListError ? screen.getByRole("alert") : screen.getByText("Existing interview")).toBe(listContent);
      expect(cardValue("Total interviews")).toHaveTextContent("4");
      expect(router.state.location.pathname).toBe("/dashboard");
      expect(localStorage.getItem("token")).toBe(tokenA);
      expect(logoutEvent).not.toHaveBeenCalled();
      expect(requests).toHaveLength(4);
    },
  );

  it.each(["cross-tab replacement", "different-user login", "same-user relogin", "same-token relogin"])(
    "loads a fresh lifecycle before old requests settle after %s",
    async (replacement) => {
      const oldStats = deferred();
      const oldList = deferred();
      expectRequest(profilePath, identity());
      expectDashboard({ stats: oldStats.promise, interviews: oldList.promise });
      const { auth, router } = await mount();
      const oldCapability = getDashboardStats.mock.lastCall[0].capability;
      const sameUser = replacement === "same-token relogin" || replacement === "same-user relogin";
      const nextToken = replacement === "same-token relogin" ? tokenA : tokenB;
      const nextUser = sameUser ? userA : userB;
      expectRequest(profilePath, identity(nextUser), nextToken);
      expectDashboard({
        token: nextToken,
        stats: json({ ...defaultStats, totalInterviews: 17 }),
        interviews: interviewList(recentInterview("Replacement interview")),
      });
      await act(async () => {
        localStorage.setItem("token", nextToken);
        if (replacement === "cross-tab replacement") {
          window.dispatchEvent(new StorageEvent("storage", {
            key: "token", oldValue: tokenA, newValue: nextToken, storageArea: localStorage,
          }));
        } else {
          await auth().completeLogin();
        }
      });
      expect(auth().session.user).toEqual(nextUser);
      expect(getDashboardStats.mock.lastCall[0].capability).not.toBe(oldCapability);
      expect(oldCapability.isCurrent()).toBe(false);
      expect(requests.slice(1, 3).every(({ signal }) => signal.aborted)).toBe(true);
      expect(screen.getByText("Replacement interview")).toBeInTheDocument();
      await act(async () => {
        oldStats.resolve(replacement === "different-user login"
          ? json({ ...defaultStats, totalInterviews: 99 })
          : json({}, 401));
        oldList.resolve(interviewList(recentInterview("Previous interview")));
      });
      expect(cardValue("Total interviews")).toHaveTextContent("17");
      expect(screen.queryByText("Previous interview")).not.toBeInTheDocument();
      expect(screen.getByText("Replacement interview")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/dashboard");
      expect(localStorage.getItem("token")).toBe(nextToken);
      expect(logoutEvent).not.toHaveBeenCalled();
    },
  );

  it("ignores a stale body rejection after the replacement dashboard loads", async () => {
    const body = deferred();
    const readBody = vi.fn(() => body.promise);
    expectRequest(profilePath, identity());
    expectDashboard({ stats: { ok: true, status: 200, text: readBody } });
    const { auth } = await mount();
    expect(readBody).toHaveBeenCalledOnce();
    expectRequest(profilePath, identity(userB), tokenB);
    expectDashboard({ token: tokenB, interviews: interviewList(recentInterview("Bob interview")) });
    await act(async () => {
      localStorage.setItem("token", tokenB);
      await auth().completeLogin();
    });
    await act(async () => body.reject(new Error("private obsolete body error")));
    expect(screen.getByText("Bob interview")).toBeInTheDocument();
    expect(cardValue("Total interviews")).toHaveTextContent("4");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe(tokenB);
  });

  it("lets the provider handle concurrent current 401 responses once", async () => {
    const stats = deferred();
    const interviews = deferred();
    expectRequest(profilePath, identity());
    expectDashboard({ stats: stats.promise, interviews: interviews.promise });
    const { auth, router } = await mount();
    await act(async () => {
      stats.resolve(json({}, 401));
      interviews.resolve(json({}, 401));
    });
    expect(auth().session.status).toBe("unauthenticated");
    expect(logoutUser).toHaveBeenCalledOnce();
    expect(logoutEvent).toHaveBeenCalledOnce();
    expect(localStorage.getItem("token")).toBeNull();
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.queryByText("Your progress")).not.toBeInTheDocument();
  });

  it.each(["logout", "provider unmount"])("cancels pending reads on %s", async (action) => {
    const stats = deferred();
    const interviews = deferred();
    expectRequest(profilePath, identity());
    expectDashboard({ stats: stats.promise, interviews: interviews.promise });
    const { auth, router, unmount } = await mount();
    const origin = getDashboardStats.mock.lastCall[0].capability;
    await act(async () => {
      if (action === "logout") auth().logout();
      else unmount();
    });
    expect(origin.isCurrent()).toBe(false);
    expect(requests.slice(1).every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => {
      stats.resolve(json({}, 401));
      interviews.resolve(interviewList(recentInterview("Late interview")));
    });
    expect(screen.queryByText("Your progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Late interview")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(action === "logout" ? "/login" : "/dashboard");
    expect(localStorage.getItem("token")).toBe(action === "logout" ? null : tokenA);
    expect(logoutEvent).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
  });
});
