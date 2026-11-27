import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../contexts/AuthContext.jsx";
import ProtectedAdminBoundary from "./ProtectedAdminBoundary.jsx";

const api = "http://localhost:5000/api";
const original = { id: "a".repeat(24), name: "Ada", email: "ada@example.test", role: "admin" };
const replacement = { ...original, id: "b".repeat(24), name: "Grace" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const adminIdentity = (user = original) => json({ success: true, data: { userId: user.id, role: "admin" } });

let sessionUser;
let adminMe;
let adminRequests;
let unexpected;
let protectedMount;
let protectedUnmount;
let capabilities;

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function Controls() {
  const { session, logout, invalidateAdminAuthorization } = useAuth();
  return (
    <>
      <output aria-label="Session">{session.status} {session.user?.name}</output>
      <button onClick={logout}>End session</button>
      <button onClick={invalidateAdminAuthorization}>Invalidate administrator authorization</button>
    </>
  );
}

function ProtectedContent({ capability }) {
  const { captureAuthenticatedRequest, session } = useAuth();
  useEffect(() => {
    capabilities = { administrator: capability, personal: captureAuthenticatedRequest() };
    protectedMount();
    return protectedUnmount;
  }, [capability, captureAuthenticatedRequest]);
  return <h1>Protected administrator content for {session.user.name}</h1>;
}

function mount({ token = "original-token", strict = false } = {}) {
  if (token) localStorage.setItem("token", token);
  const tree = (
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <AuthProvider>
        <Controls />
        <Routes>
          <Route path="/login" element={<h1>Login</h1>} />
          <Route path="/dashboard" element={<h1>Personal dashboard</h1>} />
          <Route path="/admin/dashboard" element={
            <ProtectedAdminBoundary>
              {({ capability }) => <ProtectedContent capability={capability} />}
            </ProtectedAdminBoundary>
          } />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  localStorage.clear();
  sessionUser = original;
  adminMe = () => adminIdentity();
  adminRequests = [];
  unexpected = [];
  capabilities = null;
  protectedMount = vi.fn();
  protectedUnmount = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const bearer = new Headers(options.headers).get("Authorization");
    if (options.redirect === "error" && ["Bearer original-token", "Bearer replacement-token"].includes(bearer)) {
      if (url === `${api}/auth/profile` && options.method === "GET") {
        return json({ success: true, user: bearer === "Bearer replacement-token" ? replacement : sessionUser });
      }
      if (url === `${api}/admin/me` && options.method === "GET") {
        adminRequests.push({ bearer, signal: options.signal });
        return adminMe(bearer);
      }
      if (url === `${api}/admin/probe` && options.headers instanceof Headers) return json({}, 403);
    }
    unexpected.push(url);
    throw new Error("Unexpected request");
  }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

describe("ProtectedAdminBoundary with AuthProvider", () => {
  it("redirects unauthenticated visitors to login", async () => {
    mount({ token: null });
    expect(await screen.findByRole("heading", { name: "Login" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    expect(protectedMount).not.toHaveBeenCalled();
  });

  it("keeps a regular user's session after 403 and links to their dashboard", async () => {
    sessionUser = { ...original, role: "user" };
    adminMe = () => json({}, 403);
    mount();
    expect(await screen.findByRole("heading", { name: "Access Denied" })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Back to your dashboard" }));
    expect(screen.getByRole("heading", { name: "Personal dashboard" })).toBeVisible();
    expect(screen.getByLabelText("Session")).toHaveTextContent("authenticated Ada");
    expect(localStorage.getItem("token")).toBe("original-token");
    expect(adminRequests).toHaveLength(1);
    expect(protectedMount).not.toHaveBeenCalled();
  });

  it("honors a 403 even when the verified session reports the administrator role", async () => {
    adminMe = () => json({}, 403);
    mount();
    expect(await screen.findByRole("heading", { name: "Access Denied" })).toBeVisible();
    expect(protectedMount).not.toHaveBeenCalled();
    expect(adminRequests).toHaveLength(1);
  });

  it("waits for administrator verification and makes one request under StrictMode", async () => {
    const pending = deferred();
    adminMe = () => pending.promise;
    mount({ strict: true });
    expect(await screen.findByText("Verifying administrator access…")).toHaveAttribute("role", "status");
    expect(protectedMount).not.toHaveBeenCalled();
    expect(adminRequests).toHaveLength(1);
    await act(async () => pending.resolve(adminIdentity()));
    expect(screen.getByRole("heading", { name: "Protected administrator content for Ada" })).toBeVisible();
    expect(adminRequests).toHaveLength(1);
  });

  it.each(["retry", "sign out"])("offers %s after a recoverable verification failure", async (action) => {
    adminMe = () => json({}, 503);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not verify administrator access");
    expect(adminRequests).toHaveLength(1);
    expect(protectedMount).not.toHaveBeenCalled();
    adminMe = () => adminIdentity();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${action}$`, "i") }));
    const heading = action === "retry" ? "Protected administrator content for Ada" : "Login";
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(adminRequests).toHaveLength(action === "retry" ? 2 : 1);
  });

  it("invalidates the current session after an administrator verification 401", async () => {
    adminMe = () => json({}, 401);
    mount();
    expect(await screen.findByRole("heading", { name: "Login" })).toBeVisible();
    expect(localStorage.getItem("token")).toBeNull();
    expect(adminRequests).toHaveLength(1);
    expect(protectedMount).not.toHaveBeenCalled();
  });

  it("discards a successful response after logout", async () => {
    const pending = deferred();
    adminMe = () => pending.promise;
    mount();
    await waitFor(() => expect(adminRequests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(await screen.findByRole("heading", { name: "Login" })).toBeVisible();
    expect(adminRequests[0].signal.aborted).toBe(true);
    await act(async () => pending.resolve(adminIdentity()));
    expect(protectedMount).not.toHaveBeenCalled();
  });

  it.each([200, 401])("ignores a stale %s when the account changes during verification", async (status) => {
    const originalRequest = deferred();
    const replacementRequest = deferred();
    adminMe = (bearer) => (bearer === "Bearer original-token" ? originalRequest : replacementRequest).promise;
    mount();
    await waitFor(() => expect(adminRequests).toHaveLength(1));
    act(() => {
      localStorage.setItem("token", "replacement-token");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "token", oldValue: "original-token", newValue: "replacement-token", storageArea: localStorage,
      }));
    });
    await waitFor(() => expect(adminRequests).toHaveLength(2));
    expect(adminRequests[0].signal.aborted).toBe(true);
    expect(adminRequests[1].bearer).toBe("Bearer replacement-token");
    await act(async () => originalRequest.resolve(status === 200 ? adminIdentity() : json({}, status)));
    expect(protectedMount).not.toHaveBeenCalled();
    expect(localStorage.getItem("token")).toBe("replacement-token");
    await act(async () => replacementRequest.resolve(adminIdentity(replacement)));
    expect(screen.getByRole("heading", { name: "Protected administrator content for Grace" })).toBeVisible();
    expect(adminRequests).toHaveLength(2);
  });

  it("ignores verification invalidated while pending and waits for explicit retry", async () => {
    const pending = deferred();
    adminMe = () => pending.promise;
    mount();
    await waitFor(() => expect(adminRequests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Invalidate administrator authorization" }));
    expect(adminRequests[0].signal.aborted).toBe(true);
    await act(async () => pending.resolve(adminIdentity()));
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(protectedMount).not.toHaveBeenCalled();
    expect(adminRequests).toHaveLength(1);
  });

  it("does not loop when the transport cancels verification", async () => {
    adminMe = () => { throw new DOMException("Cancelled", "AbortError"); };
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    expect(adminRequests).toHaveLength(1);
    expect(protectedMount).not.toHaveBeenCalled();
  });

  it("unmounts protected content on invalidation and captures a fresh capability on retry", async () => {
    mount();
    await screen.findByRole("heading", { name: "Protected administrator content for Ada" });
    const previous = capabilities.administrator;
    fireEvent.click(screen.getByRole("button", { name: "Invalidate administrator authorization" }));
    expect(protectedUnmount).toHaveBeenCalledOnce();
    expect(previous.isCurrent()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Protected administrator content for Ada" });
    expect(capabilities.administrator.isCurrent()).toBe(true);
    expect(previous.isCurrent()).toBe(false);
    expect(adminRequests).toHaveLength(2);
  });

  it("isolates administrator and personal capabilities and revokes only the administrator on a protected 403", async () => {
    mount();
    await screen.findByRole("heading", { name: "Protected administrator content for Ada" });
    const { administrator, personal } = capabilities;
    await expect(administrator.fetch("auth/profile")).rejects.toMatchObject({ category: "invalid-destination" });
    await expect(personal.fetch("admin/probe")).rejects.toMatchObject({ category: "invalid-destination" });
    await act(async () => {
      await expect(administrator.fetch("admin/probe")).rejects.toMatchObject({ category: "forbidden", status: 403 });
    });
    expect(screen.getByRole("heading", { name: "Access Denied" })).toBeVisible();
    expect(protectedUnmount).toHaveBeenCalledOnce();
    expect(administrator.isCurrent()).toBe(false);
    expect(personal.isCurrent()).toBe(true);
    await expect(administrator.fetch("admin/probe")).rejects.toMatchObject({ category: "stale-session" });
    expect(adminRequests).toHaveLength(1);
  });
});
