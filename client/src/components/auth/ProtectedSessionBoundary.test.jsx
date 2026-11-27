import { StrictMode, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../contexts/AuthContext.jsx";
import { CapabilityBoundMockSessionPage } from "../../pages/MockSessionPage.jsx";
import { authenticatedRequest } from "../../services/authenticatedRequest.js";
import ProtectedSessionBoundary from "./ProtectedSessionBoundary.jsx";

const API = "http://localhost:5000/api";
const TOKEN_A = "synthetic-token-a";
const TOKEN_B = "synthetic-token-b";
const USER_A = { id: "a".repeat(24), name: "User A", email: "a@example.test", role: "user" };
const USER_B = { id: "b".repeat(24), name: "User B", email: "b@example.test", role: "user" };
const PROFILE = "/auth/profile";
const RESOURCE = "/protected-test";
const MOCK_PATH = "/mock-sessions/session-a";
const MOCK_ROUTE = "/mock-session/session-a";
const MOCK_SESSION = {
  success: true,
  session: {
    _id: "session-a",
    status: "in-progress",
    answers: [{ question: "question-a", questionText: "Session question", answerText: "", order: 0 }],
  },
};

let expected;
let requests;
let pending;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function identity(user = USER_A) {
  return json({ success: true, user });
}

function defer() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  const response = { promise, resolve };
  pending.add(response);
  void promise.then(() => pending.delete(response));
  return response;
}

function expectHttp(path, response, { token = TOKEN_A, method = "GET", keepalive, body } = {}) {
  expected.push({
    request: {
      url: API + path,
      authorization: `Bearer ${token}`,
      method,
      redirect: "error",
      keepalive,
      body,
    },
    response,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  expected = [];
  requests = [];
  pending = new Set();
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const request = {
      url: String(url),
      authorization: new Headers(options.headers).get("Authorization"),
      method: options.method ?? "GET",
      redirect: options.redirect,
      keepalive: options.keepalive,
      body: options.body,
    };
    const next = expected[requests.length];
    requests.push({ request, signal: options.signal });
    if (!next || Object.keys(request).some((key) => request[key] !== next.request[key])) {
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    }
    return typeof next.response === "function" ? next.response() : next.response;
  }));
});

afterEach(async () => {
  try {
    await act(async () => {
      cleanup();
      const unfinished = [...pending];
      for (const response of unfinished) response.resolve(json({ success: false }, 503));
      await Promise.all(unfinished.map(({ promise }) => promise));
    });
    expect(requests.map(({ request }) => request)).toEqual(expected.map(({ request }) => request));
  } finally {
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

function ProtectedChild({ capability, mounts, unmounts, onCleanup, label }) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    mounts.push(capability);
    return () => {
      unmounts.push({ capability, current: capability.isCurrent() });
      onCleanup?.(capability);
    };
  }, [capability, mounts, unmounts, onCleanup]);

  return (
    <label>
      {label}
      <input value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  );
}

async function renderBoundary({ token, strict = false, onCleanup, mockPage = false } = {}) {
  if (token) window.localStorage.setItem("token", token);
  let auth;
  const report = (value) => { auth = value; };
  const mounts = [];
  const unmounts = [];

  function RouteBoundary() {
    const [label, setLabel] = useState("Draft");
    return (
      <>
        <button type="button" onClick={() => setLabel("Edited label")}>Rerender parent</button>
        <ProtectedSessionBoundary>
          {({ capability }) => mockPage
            ? <CapabilityBoundMockSessionPage capability={capability} />
            : <ProtectedChild {...{ capability, mounts, unmounts, onCleanup, label }} />}
        </ProtectedSessionBoundary>
      </>
    );
  }

  const router = createMemoryRouter([
    { path: "/protected", element: <RouteBoundary /> },
    { path: "/mock-session/:sessionId", element: <RouteBoundary /> },
    { path: "/from", element: <p>Previous route</p> },
    { path: "/login", element: <p>Login route</p> },
    { path: "/other", element: <p>Other route</p> },
  ], { initialEntries: ["/from", mockPage ? MOCK_ROUTE : "/protected"], initialIndex: 1 });
  const tree = (
    <AuthProvider>
      <AuthProbe report={report} />
      <RouterProvider router={router} />
    </AuthProvider>
  );
  await act(async () => { render(strict ? <StrictMode>{tree}</StrictMode> : tree); });
  return { auth: () => auth, router, mounts, unmounts, capability: () => mounts.at(-1) };
}

async function renderAuthenticated(options) {
  expectHttp(PROFILE, identity());
  return renderBoundary({ ...options, token: TOKEN_A });
}

async function settle(response, result) {
  await act(async () => { response.resolve(result); });
}

async function click(name) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

function edit(value) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

function storageReplacement() {
  window.localStorage.setItem("token", TOKEN_B);
  window.dispatchEvent(new StorageEvent("storage", {
    key: "token",
    oldValue: TOKEN_A,
    newValue: TOKEN_B,
    storageArea: window.localStorage,
  }));
}

function resource(capability, options) {
  return authenticatedRequest(capability, API + RESOURCE, options);
}

describe("protected session verification", () => {
  it("replaces the unauthenticated route with login without mounting protected content", async () => {
    const harness = await renderBoundary();
    expect(harness.router.state.location.pathname).toBe("/login");
    expect(harness.router.state.historyAction).toBe("REPLACE");
    expect(harness.mounts).toHaveLength(0);
    expect(harness.auth().captureAuthenticatedRequest()).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("waits for initial verification before exposing a real capability", async () => {
    const verification = defer();
    expectHttp(PROFILE, verification.promise);
    const harness = await renderBoundary({ token: TOKEN_A });
    expect(screen.getByRole("status")).toHaveTextContent("Verifying your session");
    expect(harness.router.state.location.pathname).toBe("/protected");
    expect(harness.mounts).toHaveLength(0);
    expect(requests).toHaveLength(1);
    await settle(verification, identity());
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(harness.capability().isCurrent()).toBe(true);
    expectHttp(RESOURCE, json({ success: true }));
    await expect(resource(harness.capability())).resolves.toMatchObject({ status: 200 });
  });

  it.each(["transport failure", "HTTP 503"])("offers safe recovery after initial %s", async (failure) => {
    expectHttp(PROFILE, failure === "HTTP 503"
      ? json({ detail: "Internal server detail" }, 503)
      : () => { throw new Error("Internal transport detail"); });
    const harness = await renderBoundary({ token: TOKEN_A });
    const retry = defer();
    expect(screen.getByRole("alert")).toHaveTextContent("We could not verify your session");
    expect(screen.queryByText(/Internal.*detail/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(harness.mounts).toHaveLength(0);
    expectHttp(PROFILE, retry.promise);
    const retryButton = screen.getByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Verifying your session");
    expect(requests).toHaveLength(2);
    expect(harness.mounts).toHaveLength(0);
    await settle(retry, identity());
    expect(harness.capability().isCurrent()).toBe(true);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("delegates sign out after an unavailable verification to the provider", async () => {
    expectHttp(PROFILE, json({}, 503));
    const harness = await renderBoundary({ token: TOKEN_A });
    const logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent, { once: true });
    try {
      await click("Sign out");
      expect(harness.auth().session.status).toBe("unauthenticated");
      expect(harness.router.state.location.pathname).toBe("/login");
      expect(window.localStorage.getItem("token")).toBeNull();
      expect(logoutEvent).toHaveBeenCalledTimes(1);
      expect(harness.mounts).toHaveLength(0);
    } finally {
      window.removeEventListener("prepx:logout", logoutEvent);
    }
  });
});

describe("protected capability lifecycle", () => {
  it.each(["success", "HTTP 503", "network failure"])("retains the draft and capability through background %s", async (outcome) => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    const originalUser = harness.auth().session.user;
    edit("Local draft");
    await click("Rerender parent");
    expect(screen.getByRole("textbox", { name: "Edited label" })).toHaveValue("Local draft");
    expect(harness.mounts).toEqual([origin]);
    const response = defer();
    expectHttp(PROFILE, outcome === "network failure"
      ? async () => { await response.promise; throw new Error("Synthetic network failure"); }
      : response.promise);
    await act(async () => { void harness.auth().verifySession(); });
    expect(harness.auth().session.isRevalidating).toBe(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Local draft");
    await settle(response, outcome === "success" ? identity() : json({}, 503));
    expect(harness.auth().session.status).toBe("authenticated");
    if (outcome === "success") {
      expect(harness.auth().session.user).toEqual(originalUser);
      expect(harness.auth().session.user).not.toBe(originalUser);
    } else {
      expect(harness.auth().session.error?.category).toBe(outcome === "HTTP 503" ? "service-unavailable" : "network-error");
    }
    expect(harness.mounts).toEqual([origin]);
    expect(harness.unmounts).toHaveLength(0);
    expect(harness.capability()).toBe(origin);
    expect(origin.isCurrent()).toBe(true);
    expect(screen.getByRole("textbox")).toHaveValue("Local draft");
  });

  it("keeps one originating capability through ordinary StrictMode rerenders", async () => {
    const aborted = defer();
    expectHttp(PROFILE, aborted.promise);
    expectHttp(PROFILE, identity());
    const harness = await renderBoundary({ token: TOKEN_A, strict: true });
    const origin = harness.capability();
    expect(origin.isCurrent()).toBe(true);
    expect(requests[0].signal.aborted).toBe(true);
    expect(new Set(harness.mounts)).toEqual(new Set([origin]));
    const effects = harness.mounts.length;
    edit("StrictMode draft");
    await click("Rerender parent");
    await settle(aborted, identity());
    expect(harness.mounts).toHaveLength(effects);
    expect(harness.capability()).toBe(origin);
    expect(screen.getByRole("textbox")).toHaveValue("StrictMode draft");
    expect(requests).toHaveLength(2);
  });

  it("fails closed when currentness is lost before provider state changes and recovers on retry", async () => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    edit("Old draft");
    window.localStorage.setItem("token", TOKEN_B);
    expect(origin.isCurrent()).toBe(false);
    await click("Rerender parent");
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(screen.getByRole("alert")).toHaveTextContent("We could not verify your session");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(harness.unmounts).toEqual([{ capability: origin, current: false }]);
    expect(requests).toHaveLength(1);
    expectHttp(PROFILE, identity(USER_B), { token: TOKEN_B });
    await click("Retry");
    expect(harness.auth().session.user).toEqual(USER_B);
    expect(harness.capability()).not.toBe(origin);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it.each([TOKEN_A, TOKEN_B])("remounts after same-user relogin with %s", async (newToken) => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    edit("Old draft");
    await act(async () => { harness.auth().logout(); });
    expect(harness.router.state.location.pathname).toBe("/login");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(harness.unmounts).toEqual([{ capability: origin, current: false }]);
    expectHttp(PROFILE, identity(), { token: newToken });
    await act(async () => {
      window.localStorage.setItem("token", newToken);
      await harness.auth().completeLogin();
      await harness.router.navigate("/protected");
    });
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(origin.isCurrent()).toBe(false);
    expect(harness.capability()).not.toBe(origin);
    expect(screen.getByRole("textbox")).toHaveValue("");
    await expect(resource(origin)).rejects.toMatchObject({ category: "stale-session" });
    expectHttp(RESOURCE, json({ success: true }), { token: newToken });
    await expect(resource(harness.capability())).resolves.toMatchObject({ status: 200 });
  });

  it("replaces a verified lifecycle after same-token completeLogin on the same route", async () => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    edit("Previous generation");
    expectHttp(PROFILE, identity());
    await act(async () => { await harness.auth().completeLogin(); });
    expect(harness.router.state.location.pathname).toBe("/protected");
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(harness.unmounts).toEqual([{ capability: origin, current: false }]);
    expect(harness.mounts).toHaveLength(2);
    expect(harness.capability()).not.toBe(origin);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});

describe("protected cleanup and provider-owned errors", () => {
  function cleanupRequest(results) {
    return (capability) => {
      results.push(resource(capability, { keepalive: true }).catch((error) => error));
    };
  }

  it("permits current cleanup on route exit and leaves authentication unchanged", async () => {
    const flushed = [];
    const harness = await renderAuthenticated({ onCleanup: cleanupRequest(flushed) });
    const origin = harness.capability();
    expectHttp(RESOURCE, json({ success: true }), { keepalive: true });
    await act(async () => { await harness.router.navigate("/other"); });
    expect(harness.unmounts).toEqual([{ capability: origin, current: true }]);
    await expect(flushed[0]).resolves.toMatchObject({ status: 200 });
    expect(origin.isCurrent()).toBe(true);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(requests).toHaveLength(2);
  });

  it("invalidates capability before logout-triggered cleanup can dispatch", async () => {
    const flushed = [];
    const harness = await renderAuthenticated({ onCleanup: cleanupRequest(flushed) });
    const origin = harness.capability();
    await act(async () => { harness.auth().logout(); });
    expect(harness.unmounts).toEqual([{ capability: origin, current: false }]);
    await expect(flushed[0]).resolves.toMatchObject({ category: "stale-session" });
    expect(requests).toHaveLength(1);
    expect(harness.router.state.location.pathname).toBe("/login");
  });

  it("isolates cross-tab replacement cleanup and ignores a stale 401", async () => {
    const flushed = [];
    const harness = await renderAuthenticated({ onCleanup: cleanupRequest(flushed) });
    const origin = harness.capability();
    const staleResponse = defer();
    expectHttp(RESOURCE, staleResponse.promise);
    const staleRequest = resource(origin).catch((error) => error);
    edit("User A draft");
    const replacement = defer();
    expectHttp(PROFILE, replacement.promise, { token: TOKEN_B });
    await act(async () => { storageReplacement(); });
    expect(screen.getByRole("status")).toHaveTextContent("Verifying your session");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(harness.unmounts).toEqual([{ capability: origin, current: false }]);
    await expect(flushed[0]).resolves.toMatchObject({ category: "stale-session" });
    await settle(replacement, identity(USER_B));
    expect(screen.getByRole("textbox")).toHaveValue("");
    const replacementCapability = harness.capability();
    expect(replacementCapability).not.toBe(origin);
    await settle(staleResponse, json({}, 401));
    await expect(staleRequest).resolves.toMatchObject({ category: "stale-session" });
    expect(harness.capability()).toBe(replacementCapability);
    expect(replacementCapability.isCurrent()).toBe(true);
    expect(harness.router.state.location.pathname).toBe("/protected");
    expect(harness.auth().session.user).toEqual(USER_B);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
    expectHttp(RESOURCE, json({ success: true }), { token: TOKEN_B });
    await expect(resource(replacementCapability)).resolves.toMatchObject({ status: 200 });
    await act(async () => { cleanup(); });
    await expect(flushed[1]).resolves.toMatchObject({ category: "stale-session" });
    expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
  });

  it("removes protected content on a matching 401 and preserves it on a resource 403", async () => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    edit("Keep this draft after 403");
    expectHttp(RESOURCE, json({}, 403));
    await expect(resource(origin)).rejects.toMatchObject({ category: "http-error", status: 403 });
    expect(harness.capability()).toBe(origin);
    expect(harness.unmounts).toHaveLength(0);
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft after 403");
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expectHttp(RESOURCE, json({}, 401));
    await act(async () => {
      await expect(resource(origin)).rejects.toMatchObject({ category: "unauthorized", status: 401 });
    });
    expect(harness.auth().session.status).toBe("unauthenticated");
    expect(harness.router.state.location.pathname).toBe("/login");
    expect(origin.isCurrent()).toBe(false);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("unmounts the boundary without mutating stored authentication", async () => {
    const harness = await renderAuthenticated();
    const origin = harness.capability();
    await act(async () => { cleanup(); });
    expect(origin.isCurrent()).toBe(false);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(requests).toHaveLength(1);
  });
});

describe("prepared mock-session page inside the boundary", () => {
  it("keeps a draft through revalidation and drops its pending writes on logout", async () => {
    vi.useFakeTimers();
    expectHttp(PROFILE, identity());
    expectHttp(MOCK_PATH, json(MOCK_SESSION));
    const harness = await renderBoundary({ token: TOKEN_A, mockPage: true });
    expect(screen.getByText("Session question")).toBeInTheDocument();
    edit("Old account draft");
    expectHttp(PROFILE, identity());
    await act(async () => { await harness.auth().verifySession(); });
    expect(screen.getByRole("textbox")).toHaveValue("Old account draft");
    await act(async () => { harness.auth().logout(); });
    expect(harness.router.state.location.pathname).toBe("/login");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(requests).toHaveLength(3);
    expectHttp(PROFILE, identity(USER_B), { token: TOKEN_B });
    expectHttp(MOCK_PATH, json(MOCK_SESSION), { token: TOKEN_B });
    await act(async () => {
      window.localStorage.setItem("token", TOKEN_B);
      await harness.auth().completeLogin();
      await harness.router.navigate(MOCK_ROUTE);
    });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("lets a dirty protected page flush with its originating token on ordinary route exit", async () => {
    vi.useFakeTimers();
    expectHttp(PROFILE, identity());
    expectHttp(MOCK_PATH, json(MOCK_SESSION));
    const harness = await renderBoundary({ token: TOKEN_A, mockPage: true });
    edit("Keepalive draft");
    expectHttp(`${MOCK_PATH}/answers/question-a`, json({ success: true }), {
      method: "PATCH",
      keepalive: true,
      body: JSON.stringify({ answerText: "Keepalive draft" }),
    });
    await act(async () => { await harness.router.navigate("/other"); });
    expect(harness.auth().session.user).toEqual(USER_A);
    expect(requests).toHaveLength(3);
  });
});
