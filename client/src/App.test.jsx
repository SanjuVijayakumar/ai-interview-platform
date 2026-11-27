import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutletContext } from "react-router-dom";
import App from "./App.jsx";

vi.mock("./pages/AdminDashboardPlaceholder.jsx", async (importOriginal) => {
  const { default: AdminDashboardPlaceholder } = await importOriginal();
  return {
    default: function DashboardWithCapabilityObserver() {
      const { capability } = useOutletContext();
      useEffect(() => { observeAdminCapability?.(capability); }, [capability]);
      return <AdminDashboardPlaceholder />;
    },
  };
});

const api = "http://localhost:5000/api";
const token = "synthetic-app-token";
const nextToken = "synthetic-replacement-token";
const profile = {
  id: "a".repeat(24), role: "user", name: "Ada Lovelace", email: "ada@example.test",
  skills: ["React", "Node.js"], experience: 5, targetRole: "Senior Engineer",
};
const replacement = { ...profile, id: "b".repeat(24), name: "Grace Hopper", email: "grace@example.test" };
const credentials = { email: profile.email, password: "synthetic-password" };
const interview = { _id: "interview-a", title: "Fixture interview", status: "pending" };
const session = {
  _id: "session-a", status: "in-progress", interview: interview._id,
  answers: [{ question: "question-a", questionText: "Fixture question", answerText: "", order: 0 }],
};
const result = { ...session, status: "completed", answers: [] };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function identity(user = profile) {
  return json({ success: true, user });
}

function administratorIdentity(user = profile) {
  return json({ success: true, data: { userId: user.id, role: "admin" } });
}

function administratorRequests() {
  return calls.filter(({ path }) => path === "/admin/me");
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

const routeResponses = {
  "/dashboard/stats": () => json({ totalInterviews: 1, completedInterviews: 0, pendingInterviews: 1, averageScore: null }),
  "/interviews": () => json({ success: true, interviews: [interview] }),
  "/interviews/interview-a": () => json({ success: true, interview }),
  "/interviews/interview-a/sessions/in-progress": () => json({ success: false, message: "No in-progress session found" }, 404),
  "/questions/interview-a": () => json({ success: true, questions: [] }),
  "/mock-sessions/session-a": () => json({ success: true, session }),
  "/results": () => json({ success: true, results: [result] }),
  "/results/session-a": () => json({ success: true, result }),
  "/mock-sessions/session-a/evaluation": () => json({ success: true, status: "not-requested", attemptCount: 0 }),
};

let calls;
let unexpected;
let respond;
let currentProfile;
let observeAdminCapability;

function defaultResponse(request) {
  const { path, method, kind, bearer, body } = request;
  if (kind === "health") return json({ message: "Backend is available" });
  if (kind === "login") return json({ success: true, token, user: profile });
  if (path === "/auth/profile" && method === "GET") return identity(bearer === nextToken ? replacement : currentProfile);
  if (path === "/auth/profile" && method === "PATCH") {
    currentProfile = { ...currentProfile, ...body };
    return identity(currentProfile);
  }
  if (method === "GET" && Object.hasOwn(routeResponses, path)) return routeResponses[path]();
  unexpected.push(request);
  throw new Error("Unexpected request");
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  unexpected = [];
  currentProfile = profile;
  respond = defaultResponse;
  observeAdminCapability = null;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const path = String(url).slice(api.length);
    const capability = options?.headers instanceof Headers;
    const method = options?.method;
    const kind = path === "/health" ? "health" : path === "/auth/login" ? "login" :
      capability ? "capability" : "identity";
    const authorization = new Headers(options?.headers).get("Authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const request = {
      path, kind, method, bearer, redirect: options?.redirect, signal: options?.signal,
      contentType: new Headers(options?.headers).get("Content-Type"),
      body: options?.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(request);
    const allowed = url === api + path && (
      (kind === "health" && options === undefined) ||
      (options?.redirect === "error" && (
        (kind === "login" && method === "POST" && !authorization && request.contentType === "application/json") ||
        (Boolean(bearer) && (kind === "capability" ||
          (["/auth/profile", "/admin/me"].includes(path) && method === "GET")))
      ))
    );
    if (!allowed) {
      unexpected.push(request);
      throw new Error("Unexpected transport options");
    }
    return respond(request);
  }));
});

afterEach(() => {
  try {
    cleanup();
    expect(unexpected).toEqual([]);
  } finally {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function mount(path, savedToken = token, strict = false) {
  if (savedToken) localStorage.setItem("token", savedToken);
  window.history.replaceState({}, "", path);
  return render(strict ? <StrictMode><App /></StrictMode> : <App />);
}

function changeToken(value) {
  const oldValue = localStorage.getItem("token");
  if (value) localStorage.setItem("token", value);
  else localStorage.removeItem("token");
  window.dispatchEvent(new StorageEvent("storage", {
    key: "token", oldValue, newValue: value, storageArea: localStorage,
  }));
}

function visit(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function sidebar() {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

function navbar() {
  return within(screen.getByText("PREPX WORKSPACE").closest("header"));
}

function submitLogin() {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: credentials.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: credentials.password } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form"));
}

function protectedReads() {
  return calls.filter(({ kind }) => kind === "capability");
}

describe("atomic production authentication", () => {
  it.each(["/profile", "/unknown", "/admin/dashboard"])("redirects unauthenticated visits to %s and checks health independently", async (path) => {
    mount(path, null);
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
    expect(await screen.findByText("Backend is available")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(calls.map(({ kind }) => kind)).toEqual(["health"]);
    expect(location.pathname).toBe("/login");
  });

  it("protects direct navigation to /admin/dashboard until the administrator endpoint approves access", async () => {
    const pending = deferred();
    respond = (request) => request.path === "/admin/me" ? pending.promise : defaultResponse(request);
    mount("/admin/dashboard");
    expect(await screen.findByText("Verifying administrator access…")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Administrator Dashboard" })).not.toBeInTheDocument();
    await waitFor(() => expect(administratorRequests()).toEqual([
      expect.objectContaining({ method: "GET", bearer: token, redirect: "error" }),
    ]));
    await act(async () => pending.resolve(administratorIdentity()));
    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(location.pathname).toBe("/admin/dashboard");
    expect(protectedReads()).toEqual([]);
  });

  it.each(["/dashboard", "/login", "/", "/unknown"])("waits for stored-token verification before opening %s", async (path) => {
    const pending = deferred();
    respond = (request) => request.kind === "identity" ? pending.promise : defaultResponse(request);
    mount(path);
    expect(screen.getByText(/Verifying your session/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(protectedReads()).toEqual([]);
    await act(async () => pending.resolve(identity()));
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
    expect(navbar().getByText(profile.name)).toBeInTheDocument();
    expect(location.pathname).toBe("/dashboard");
    expect(calls.filter(({ kind }) => kind === "identity")).toHaveLength(1);
    expect(administratorRequests()).toEqual([]);
  });

  it("invalidates an expired stored token and reaches the real login route", async () => {
    respond = (request) => request.kind === "identity" ? json({ message: "private" }, 401) : defaultResponse(request);
    mount("/dashboard");
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBeNull();
    expect(protectedReads()).toEqual([]);
  });

  it.each([["/dashboard", "retry"], ["/login", "retry"], ["/login", "sign out"]])(
    "recovers from initial verification failure on %s via %s", async (path, action) => {
      respond = (request) => request.kind === "identity" ? json({ message: "private" }, 503) : defaultResponse(request);
      mount(path);
      expect(await screen.findByRole("heading", { name: "Session verification unavailable" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).not.toHaveTextContent("private");
      expect(localStorage.getItem("token")).toBe(token);
      expect(protectedReads()).toEqual([]);
      respond = defaultResponse;
      fireEvent.click(screen.getByRole("button", { name: action === "retry" ? "Retry" : "Sign out" }));
      if (action === "retry") {
        expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
        expect(calls.filter(({ kind }) => kind === "identity")).toHaveLength(2);
      } else {
        expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
        expect(localStorage.getItem("token")).toBeNull();
      }
    },
  );

  it("keeps its form mounted through login verification and submits once under StrictMode", async () => {
    const verification = deferred();
    respond = (request) => request.kind === "identity" ? verification.promise : defaultResponse(request);
    mount("/login", null, true);
    const form = screen.getByRole("button", { name: "Sign in" }).closest("form");
    submitLogin();
    fireEvent.submit(form);
    await waitFor(() => expect(calls.some(({ kind }) => kind === "identity")).toBe(true));
    expect(screen.getByRole("button", { name: /signing in/i }).closest("form")).toBe(form);
    expect(protectedReads()).toEqual([]);
    expect(calls.filter(({ kind }) => kind === "login")).toEqual([
      expect.objectContaining({ path: "/auth/login", method: "POST", body: credentials, signal: expect.any(AbortSignal) }),
    ]);
    await act(async () => verification.resolve(identity()));
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
    expect(location.pathname).toBe("/dashboard");
    expect(administratorRequests()).toEqual([]);
  });

  it("keeps the form and reports local verification failure after an accepted exchange", async () => {
    respond = (request) => request.kind === "identity" ? json({}, 503) : defaultResponse(request);
    mount("/login", null);
    submitLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not verify your session");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(localStorage.getItem("token")).toBeNull();
    expect(location.pathname).toBe("/login");
  });

  it("waits on /login after an administrator signs in and reuses authorization at the destination in StrictMode", async () => {
    const pending = deferred();
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? pending.promise : defaultResponse(request);
    mount("/login", null, true);
    const replace = vi.spyOn(window.history, "replaceState");
    submitLogin();
    expect(await screen.findByText("Verifying administrator access…")).toHaveAttribute("role", "status");
    expect(location.pathname).toBe("/login");
    await waitFor(() => expect(administratorRequests()).toEqual([
      expect.objectContaining({ method: "GET", bearer: token, redirect: "error" }),
    ]));
    expect(protectedReads()).toEqual([]);
    await act(async () => pending.resolve(administratorIdentity()));
    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(location.pathname).toBe("/admin/dashboard");
    expect(administratorRequests()).toHaveLength(1);
    expect(replace.mock.calls.map(([, , url]) => url)).toEqual(["/admin/dashboard"]);
  });

  it.each(["/login", "/"])("verifies a restored administrator visiting %s before redirecting", async (path) => {
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? administratorIdentity() : defaultResponse(request);
    mount(path);
    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(location.pathname).toBe("/admin/dashboard");
    expect(administratorRequests()).toHaveLength(1);
    expect(calls.filter(({ kind }) => kind === "login")).toHaveLength(0);
  });

  it("reuses current administrator authorization when returning to a landing route", async () => {
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? administratorIdentity() : defaultResponse(request);
    mount("/admin/dashboard");
    await screen.findByRole("heading", { name: "Administrator Dashboard" });
    await act(async () => visit("/login"));
    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(location.pathname).toBe("/admin/dashboard");
    expect(administratorRequests()).toHaveLength(1);
  });

  it("keeps ordinary personal navigation when an abandoned landing verification succeeds", async () => {
    const pending = deferred();
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? pending.promise : defaultResponse(request);
    mount("/");
    await screen.findByText("Verifying administrator access…");
    await waitFor(() => expect(administratorRequests()).toHaveLength(1));
    await act(async () => visit("/dashboard"));
    await screen.findByRole("heading", { name: "Welcome back, Ada" });
    await act(async () => pending.resolve(administratorIdentity()));
    expect(location.pathname).toBe("/dashboard");
    expect(administratorRequests()).toHaveLength(1);
  });

  it("allows an administrator to open the personal dashboard directly without administrator verification", async () => {
    currentProfile = { ...profile, role: "admin" };
    mount("/dashboard");
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeVisible();
    expect(location.pathname).toBe("/dashboard");
    expect(administratorRequests()).toEqual([]);
  });

  it.each([401, 403])("handles a current administrator verification %s after login", async (status) => {
    const pending = deferred();
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? pending.promise : defaultResponse(request);
    mount("/login", null);
    submitLogin();
    await screen.findByText("Verifying administrator access…");
    await waitFor(() => expect(administratorRequests()).toHaveLength(1));
    await act(async () => pending.resolve(json({}, status)));
    const heading = status === 401 ? "Sign in to PrepX" : "Welcome back, Ada";
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(location.pathname).toBe(status === 401 ? "/login" : "/dashboard");
    expect(localStorage.getItem("token")).toBe(status === 401 ? null : token);
    expect(administratorRequests()).toHaveLength(1);
  });

  it.each([
    ["Retry", "Administrator Dashboard", "/admin/dashboard"],
    ["Sign out", "Sign in to PrepX", "/login"],
    ["Continue to personal dashboard", "Welcome back, Ada", "/dashboard"],
  ])("offers %s after a recoverable administrator verification failure", async (action, heading, path) => {
    currentProfile = { ...profile, role: "admin" };
    respond = (request) => request.path === "/admin/me" ? json({}, 503) : defaultResponse(request);
    mount("/login", null);
    submitLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not verify administrator access");
    expect(location.pathname).toBe("/login");
    expect(localStorage.getItem("token")).toBe(token);
    expect(protectedReads()).toEqual([]);
    expect(administratorRequests()).toHaveLength(1);
    respond = (request) => request.path === "/admin/me" ? administratorIdentity() : defaultResponse(request);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(location.pathname).toBe(path);
    expect(administratorRequests()).toHaveLength(action === "Retry" ? 2 : 1);
  });

  it.each([[null, 200], [nextToken, 200], [nextToken, 401]])(
    "discards pending administrator verification after cross-tab token change to %s with stale status %s",
    async (newToken, status) => {
      const pending = deferred();
      currentProfile = { ...profile, role: "admin" };
      respond = (request) => request.path === "/admin/me" ? pending.promise : defaultResponse(request);
      mount("/login", null);
      submitLogin();
      await screen.findByText("Verifying administrator access…");
      await waitFor(() => expect(administratorRequests()).toHaveLength(1));
      await act(async () => changeToken(newToken));
      const heading = newToken ? "Welcome back, Grace" : "Sign in to PrepX";
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      expect(administratorRequests()[0].signal.aborted).toBe(true);
      await act(async () => pending.resolve(status === 200 ? administratorIdentity() : json({}, status)));
      expect(location.pathname).toBe(newToken ? "/dashboard" : "/login");
      expect(localStorage.getItem("token")).toBe(newToken);
      expect(administratorRequests()).toHaveLength(1);
    },
  );

  it("verifies a cross-tab administrator sign-in without submitting the login form", async () => {
    const admin = { ...replacement, role: "admin" };
    respond = (request) => {
      if (request.path === "/auth/profile") return identity(admin);
      if (request.path === "/admin/me") return administratorIdentity(admin);
      return defaultResponse(request);
    };
    mount("/login", null);
    await act(async () => changeToken(nextToken));
    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(administratorRequests()).toEqual([expect.objectContaining({ bearer: nextToken })]);
    expect(calls.filter(({ kind }) => kind === "login")).toEqual([]);
  });

  it("redirects a login route after external verification with no local submission", async () => {
    const pending = deferred();
    respond = (request) => request.kind === "identity" ? pending.promise : defaultResponse(request);
    mount("/login", null);
    expect(screen.getByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
    await act(async () => changeToken(nextToken));
    expect(screen.getByText(/Verifying your session/)).toBeInTheDocument();
    expect(protectedReads()).toEqual([]);
    await act(async () => pending.resolve(identity(replacement)));
    expect(await screen.findByRole("heading", { name: "Welcome back, Grace" })).toBeInTheDocument();
    expect(calls.filter(({ kind }) => kind === "login")).toEqual([]);
  });

  it("defers navigation while a superseded local submission settles, then shows only the verified replacement", async () => {
    const exchange = deferred();
    respond = (request) => request.kind === "login" ? exchange.promise : defaultResponse(request);
    mount("/login", null);
    submitLogin();
    await act(async () => changeToken(nextToken));
    expect(location.pathname).toBe("/login");
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    expect(calls.find(({ kind }) => kind === "login").signal.aborted).toBe(true);
    expect(protectedReads()).toEqual([]);
    await act(async () => exchange.resolve(json({ success: true, user: { ...profile, role: "admin" }, token })));
    expect(await screen.findByRole("heading", { name: "Welcome back, Grace" })).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe(nextToken);
    expect(protectedReads().every(({ bearer }) => bearer === nextToken)).toBe(true);
    expect(administratorRequests()).toEqual([]);
  });

  it("keeps a newer form submission active when an unmounted form settles", async () => {
    const original = deferred();
    const verification = deferred();
    respond = (request) => {
      if (request.kind === "login" && calls.filter(({ kind }) => kind === "login").length === 1) return original.promise;
      if (request.kind === "identity") return verification.promise;
      return defaultResponse(request);
    };
    mount("/login", null);
    const oldForm = screen.getByRole("button", { name: "Sign in" }).closest("form");
    submitLogin();
    await act(async () => visit("/dashboard"));
    expect(location.pathname).toBe("/login");
    expect(screen.getByRole("button", { name: "Sign in" }).closest("form")).not.toBe(oldForm);
    submitLogin();
    await waitFor(() => expect(calls.filter(({ kind }) => kind === "identity")).toHaveLength(1));
    await act(async () => original.resolve(json({ message: "private" }, 401)));
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(location.pathname).toBe("/login");
    await act(async () => verification.resolve(identity()));
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
  });

  it("keeps public health failure independent of authenticated data", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respond = (request) => {
      if (request.kind === "health") throw new Error("synthetic health failure");
      return defaultResponse(request);
    };
    mount("/profile");
    expect(await screen.findByDisplayValue(profile.email)).toHaveAttribute("readonly");
    expect(await screen.findByText("Could not reach backend")).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe(token);
  });
});

describe("protected production routes and layout", () => {
  it.each([
    ["/dashboard", ["/dashboard/stats", "/interviews"]],
    ["/interviews", ["/interviews"]],
    ["/interviews/interview-a", ["/interviews/interview-a", "/questions/interview-a", "/interviews/interview-a/sessions/in-progress"]],
    ["/mock-session/session-a", ["/mock-sessions/session-a"]],
    ["/results", ["/results"]],
    ["/results/session-a", ["/results/session-a", "/mock-sessions/session-a/evaluation"]],
    ["/profile", ["/auth/profile"]],
  ])("opens %s using only capability-bound resource requests", async (path, resources) => {
    mount(path);
    await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() => expect(protectedReads().map(({ path: resource }) => resource)).toEqual(expect.arrayContaining(resources)));
    expect(protectedReads()).toHaveLength(resources.length);
    for (const request of protectedReads()) {
      expect(request).toMatchObject({ bearer: token, method: "GET", redirect: "error" });
    }
    expect(location.pathname).toBe(path);
  });

  it("renders the shared layout and keeps it mounted during sidebar navigation", async () => {
    const user = userEvent.setup();
    mount("/profile");
    expect(await screen.findByDisplayValue(profile.email)).toHaveAttribute("readonly");
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PrepX home" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Log out" })).toHaveLength(1);
    const navigation = sidebar();
    for (const label of ["Profile", "Dashboard", "My Interviews", "My Results", "Profile"]) {
      const link = within(navigation).getByRole("link", { name: label });
      await user.click(link);
      expect(link).toHaveClass("theme-sidebar-active");
      expect(navbar().getByRole("heading", { name: label })).toBeInTheDocument();
      expect(sidebar()).toBe(navigation);
    }
    expect(calls.filter(({ kind }) => kind === "identity")).toHaveLength(1);
  });

  it("saves the exact profile payload and refreshes verified Navbar identity without remounting the form", async () => {
    const verification = deferred();
    respond = (request) => request.kind === "identity" && currentProfile !== profile
      ? verification.promise : defaultResponse(request);
    mount("/profile");
    const emailField = await screen.findByDisplayValue(profile.email);
    const updates = { name: "Ada B. Lovelace", skills: ["React", "TypeScript"], experience: 6.5, targetRole: "Principal Engineer" };
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: updates.name } });
    fireEvent.change(screen.getByLabelText("Skills"), { target: { value: updates.skills.join(", ") } });
    fireEvent.change(screen.getByLabelText("Experience"), { target: { value: updates.experience } });
    fireEvent.change(screen.getByLabelText("Target role"), { target: { value: updates.targetRole } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(calls.filter(({ kind }) => kind === "identity")).toHaveLength(2));
    expect(calls.filter(({ method }) => method === "PATCH")).toEqual([expect.objectContaining({
      path: "/auth/profile", kind: "capability", bearer: token, body: updates, contentType: "application/json",
    })]);
    expect(navbar().getByText(profile.name)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBe(emailField);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Unsaved draft" } });
    await act(async () => verification.resolve(identity(currentProfile)));
    expect(await screen.findByText("Your profile has been updated successfully.")).toBeInTheDocument();
    expect(navbar().getByText(updates.name)).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Unsaved draft");
  });

  it.each([401, 403])("handles a current profile PATCH returning %s through the provider", async (status) => {
    respond = (request) => request.method === "PATCH" ? json({ message: "private" }, status) : defaultResponse(request);
    mount("/profile");
    await screen.findByDisplayValue(profile.email);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    if (status === 401) {
      expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
      expect(localStorage.getItem("token")).toBeNull();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission");
      expect(sidebar()).toBeInTheDocument();
      expect(localStorage.getItem("token")).toBe(token);
    }
  });

  it("unmounts old protected content during cross-tab replacement and on token removal", async () => {
    const verification = deferred();
    respond = (request) => request.kind === "identity" && request.bearer === nextToken
      ? verification.promise : defaultResponse(request);
    mount("/profile");
    await screen.findByDisplayValue(profile.email);
    const oldSidebar = sidebar();
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Old draft" } });
    await act(async () => changeToken(nextToken));
    expect(screen.queryByDisplayValue("Old draft")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    await act(async () => verification.resolve(identity(replacement)));
    expect(await screen.findByDisplayValue(replacement.email)).toBeInTheDocument();
    expect(sidebar()).not.toBe(oldSidebar);
    expect(navbar().getByText(replacement.name)).toBeInTheDocument();
    expect(protectedReads().map(({ bearer }) => bearer)).toEqual([token, nextToken]);
    await act(async () => changeToken(null));
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
  });

  it("logs out from Sidebar and verifies a same-user relogin with the same token again", async () => {
    mount("/dashboard");
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
    const oldSidebar = sidebar();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBeNull();
    submitLogin();
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeInTheDocument();
    expect(sidebar()).not.toBe(oldSidebar);
    expect(calls.filter(({ kind }) => kind === "identity").map(({ bearer }) => bearer)).toEqual([token, token]);
  });
});

describe("administrator workspace", () => {
  const pages = [
    ["dashboard", "Dashboard"],
    ["users", "Users"],
    ["interviews", "Interviews"],
    ["questions", "Questions"],
    ["evaluations", "Evaluations"],
    ["ai-monitoring", "AI Monitoring"],
    ["activity-logs", "Activity Logs"],
    ["profile", "Profile"],
  ];
  const admin = { ...profile, role: "admin" };
  const nextAdmin = { ...replacement, role: "admin" };

  function adminNavigation() {
    return screen.getByRole("navigation", { name: "Administrator navigation" });
  }

  function allowAdmin(request) {
    const account = request.bearer === nextToken ? nextAdmin : admin;
    if (request.path === "/auth/profile") return identity(account);
    if (request.path === "/admin/me") return administratorIdentity(account);
    return defaultResponse(request);
  }

  it.each(pages)("opens /admin/%s directly", async (path, title) => {
    respond = allowAdmin;
    mount(`/admin/${path}`);
    expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(within(adminNavigation()).getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("main")).getByText(/pending\.$/)).toBeVisible();
    expect(administratorRequests()).toHaveLength(1);
    expect(protectedReads()).toEqual([]);
  });

  it.each([...pages.map(([path]) => `/admin/${path}`), "/admin", "/admin/missing/deep"])(
    "denies regular-user access to %s",
    async (path) => {
      respond = (request) => request.path === "/admin/me" ? json({}, 403) : defaultResponse(request);
      mount(path);
      expect(await screen.findByRole("heading", { name: "Access Denied" })).toBeVisible();
      expect(screen.queryByRole("navigation", { name: "Administrator navigation" })).toBeNull();
      expect(location.pathname).toBe(path);
      expect(localStorage.getItem("token")).toBe(token);
    },
  );

  it.each(["/admin", "/admin/users", "/admin/missing/deep"])("redirects unauthenticated access to %s", async (path) => {
    mount(path, null);
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeVisible();
    expect(location.pathname).toBe("/login");
    expect(administratorRequests()).toEqual([]);
    expect(screen.queryByRole("navigation", { name: "Administrator navigation" })).toBeNull();
  });

  it("waits for authorization before redirecting the index and preserves the shell through navigation", async () => {
    const verification = deferred();
    const user = userEvent.setup();
    respond = (request) => request.path === "/admin/me" ? verification.promise : allowAdmin(request);
    mount("/admin", token, true);
    await waitFor(() => expect(administratorRequests()).toHaveLength(1));
    expect(location.pathname).toBe("/admin");
    expect(screen.queryByRole("navigation", { name: "Administrator navigation" })).toBeNull();
    await act(async () => verification.resolve(administratorIdentity(admin)));

    expect(await screen.findByRole("heading", { name: "Administrator Dashboard" })).toBeVisible();
    expect(location.pathname).toBe("/admin/dashboard");
    const nav = adminNavigation();
    const header = screen.getByRole("banner");
    const initialIdentityRequests = calls.filter(({ path }) => path === "/auth/profile").length;
    expect(within(header).getByText(admin.name)).toBeVisible();
    expect(within(header).getByText("AL")).toBeVisible();
    expect(within(header).getByText("Administrator")).toBeVisible();
    expect(within(header).getByText("PrepX Administrator Workspace")).toBeVisible();
    expect(within(nav).getAllByRole("group").map((group) => group.getAttribute("aria-label")))
      .toEqual(["Overview", "Management", "Monitoring", "Account"]);

    for (const [path, title] of pages) {
      const link = within(nav).getByRole("link", { name: title });
      await user.click(link);
      expect(location.pathname).toBe(`/admin/${path}`);
      expect(link).toHaveClass("theme-sidebar-active");
      expect(within(nav).getAllByRole("link", { current: "page" })).toEqual([link]);
      expect(within(header).getByRole("heading", { name: title })).toBeVisible();
      expect(adminNavigation()).toBe(nav);
      expect(screen.getByRole("banner")).toBe(header);
    }

    await act(async () => visit("/admin/missing/deep"));
    expect(screen.getByRole("heading", { name: "Administrator page unavailable" })).toBeVisible();
    expect(adminNavigation()).toBe(nav);
    expect(within(nav).queryByRole("link", { current: "page" })).toBeNull();
    expect(administratorRequests()).toHaveLength(1);
    expect(calls.filter(({ path }) => path === "/auth/profile")).toHaveLength(initialIdentityRequests);

    await user.click(within(nav).getByRole("link", { name: "User Dashboard" }));
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeVisible();
    expect(location.pathname).toBe("/dashboard");
    expect(sidebar()).toBeVisible();
  });

  it("logs out from the administrator sidebar", async () => {
    respond = allowAdmin;
    mount("/admin/profile");
    const nav = await screen.findByRole("navigation", { name: "Administrator navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to PrepX" })).toBeVisible();
    expect(nav).not.toBeInTheDocument();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("passes an administrator-scoped capability to the outlet and removes the shell on revocation", async () => {
    observeAdminCapability = vi.fn();
    respond = (request) => request.path === "/admin/probe" ? json({}, 403) : allowAdmin(request);
    mount("/admin/dashboard");
    await screen.findByRole("heading", { name: "Administrator Dashboard" });
    const [[capability]] = observeAdminCapability.mock.calls;
    expect(capability.isCurrent()).toBe(true);
    await expect(capability.fetch("dashboard/stats")).rejects.toBeDefined();
    expect(protectedReads()).toEqual([]);

    await act(async () => {
      await expect(capability.fetch("admin/probe")).rejects.toMatchObject({ category: "forbidden", status: 403 });
    });
    expect(protectedReads()).toEqual([expect.objectContaining({ path: "/admin/probe", bearer: token })]);
    expect(capability.isCurrent()).toBe(false);
    expect(screen.getByRole("heading", { name: "Access Denied" })).toBeVisible();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    expect(localStorage.getItem("token")).toBe(token);
  });

  it("removes the outgoing shell and waits for the replacement administrator's authorization", async () => {
    const verification = deferred();
    observeAdminCapability = vi.fn();
    respond = (request) => request.path === "/admin/me" && request.bearer === nextToken
      ? verification.promise : allowAdmin(request);
    mount("/admin/dashboard");
    const oldNav = await screen.findByRole("navigation", { name: "Administrator navigation" });
    const [[oldCapability]] = observeAdminCapability.mock.calls;
    expect(screen.getByText(admin.name)).toBeVisible();

    await act(async () => changeToken(nextToken));
    await waitFor(() => expect(administratorRequests()).toHaveLength(2));
    expect(oldNav).not.toBeInTheDocument();
    expect(screen.queryByText(admin.name)).toBeNull();
    expect(screen.queryByText(nextAdmin.name)).toBeNull();
    expect(oldCapability.isCurrent()).toBe(false);

    await act(async () => verification.resolve(administratorIdentity(nextAdmin)));
    expect(await screen.findByText(nextAdmin.name)).toBeVisible();
    expect(adminNavigation()).not.toBe(oldNav);
    const [newCapability] = observeAdminCapability.mock.lastCall;
    expect(newCapability).not.toBe(oldCapability);
    expect(newCapability.isCurrent()).toBe(true);
  });
});
