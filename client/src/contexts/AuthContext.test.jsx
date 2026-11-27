import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminIdentity } from "../services/adminService.js";
import { exchangeLoginCredentials, getAuthToken, getSessionIdentity, logoutUser } from "../services/authService.js";
import { AuthProvider, useAuth } from "./AuthContext.jsx";

vi.mock("../services/adminService.js", () => ({
  getAdminIdentity: vi.fn(),
}));

vi.mock("../services/authService.js", () => ({
  exchangeLoginCredentials: vi.fn(),
  getAuthToken: vi.fn(),
  getSessionIdentity: vi.fn(),
  logoutUser: vi.fn(),
}));

const TOKEN_A = "synthetic-session-token-a";
const TOKEN_B = "synthetic-session-token-b";
const TOKEN_C = "synthetic-session-token-c";
const IDENTITY_A = Object.freeze({
  id: "507f1f77bcf86cd799439011",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "user",
});
const IDENTITY_B = Object.freeze({
  id: "507f1f77bcf86cd799439012",
  name: "Grace Hopper",
  email: "grace@example.com",
  role: "admin",
});
const IDENTITY_C = Object.freeze({
  id: "507f1f77bcf86cd799439013",
  name: "Katherine Johnson",
  email: "katherine@example.com",
  role: "user",
});
const IDENTITY_A_ADMIN = Object.freeze({ ...IDENTITY_A, role: "admin" });
const IDENTITY_A_REFRESH = Object.freeze({ ...IDENTITY_A, name: "Ada Byron" });
const ADMIN_IDENTITY_A = Object.freeze({
  userId: IDENTITY_A.id,
  role: "admin",
});
const ADMIN_IDENTITY_B = Object.freeze({
  userId: IDENTITY_B.id,
  role: "admin",
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serviceError(category, status) {
  return Object.assign(new Error(`Synthetic private detail for ${TOKEN_A}`), {
    category,
    ...(status === undefined ? {} : { status }),
  });
}

function setStoredToken(token) {
  window.localStorage.removeItem("token");
  if (token) window.localStorage.setItem("token", token);
}

function dispatchStorageEvent({
  key,
  oldValue = null,
  newValue = null,
  storageArea = window.localStorage,
}) {
  window.dispatchEvent(new StorageEvent("storage", {
    key,
    oldValue,
    newValue,
    storageArea,
    url: window.location.href,
  }));
}

function updateTokenAndDispatch(token, eventValues = {}) {
  const oldValue = window.localStorage.getItem("token");
  setStoredToken(token);
  dispatchStorageEvent({
    key: "token",
    oldValue,
    newValue: token,
    ...eventValues,
  });
}

function Probe({ onRender }) {
  const auth = useAuth();
  onRender?.(auth);
  return <p>Authentication context ready</p>;
}

function renderProvider({ token = null, strict = false, onRender } = {}) {
  setStoredToken(token);
  const latest = { auth: null };
  const handleRender = (auth) => {
    latest.auth = auth;
    onRender?.(auth);
  };
  const content = <AuthProvider><Probe onRender={handleRender} /></AuthProvider>;
  const result = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { ...result, auth: () => latest.auth };
}

function expectInitialSession(session) {
  expect(session).toEqual({
    status: "unauthenticated",
    user: null,
    error: null,
    isRevalidating: false,
  });
}

function expectInitialAdministrator(administrator) {
  expect(administrator).toEqual({
    status: "not-requested",
    identity: null,
    error: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  getAuthToken.mockImplementation(() => window.localStorage.getItem("token"));
  exchangeLoginCredentials.mockReset();
  getSessionIdentity.mockReset();
  getSessionIdentity.mockResolvedValue(IDENTITY_A);
  getAdminIdentity.mockReset();
  getAdminIdentity.mockResolvedValue(ADMIN_IDENTITY_A);
  logoutUser.mockImplementation(() => {
    window.localStorage.removeItem("token");
    window.dispatchEvent(new Event("prepx:logout"));
  });
  vi.stubGlobal("fetch", vi.fn());
});

describe("provider-owned login", () => {
  const credentials = { email: "login@example.test", password: "synthetic-password" };

  function startLogin(auth) {
    let result;
    act(() => { result = auth().login(credentials); });
    return result;
  }

  it("persists only the accepted token and establishes identity only after verification in StrictMode", async () => {
    const { auth } = renderProvider({ strict: true });
    const verification = deferred();
    exchangeLoginCredentials.mockResolvedValue({ token: TOKEN_A, user: IDENTITY_B });
    getSessionIdentity.mockReturnValue(verification.promise);
    const login = startLogin(auth);
    await act(async () => {});
    expect(getAuthToken()).toBe(TOKEN_A);
    expect(auth().session.status).toBe("verifying");
    expect(auth().session.user).toBeNull();
    expect(auth().captureAuthenticatedRequest()).toBeNull();
    expect(exchangeLoginCredentials).toHaveBeenCalledExactlyOnceWith(credentials, { signal: expect.any(AbortSignal) });
    expect(getSessionIdentity).toHaveBeenCalledExactlyOnceWith(TOKEN_A, { signal: expect.any(AbortSignal) });
    await act(async () => verification.resolve(IDENTITY_A));
    const result = await login;
    expect(result.status).toBe("authenticated");
    expect(result.isCurrent()).toBe(true);
    expect(result).not.toHaveProperty("token");
    expect(auth().session.user).toEqual(IDENTITY_A);
    expectInitialAdministrator(auth().administrator);
    expect(getAdminIdentity).not.toHaveBeenCalled();
    act(() => auth().logout());
    expect(result.isCurrent()).toBe(false);
  });

  it.each(["success", "failure"])("discards a late credential %s after a newer login", async (outcome) => {
    const { auth } = renderProvider();
    const late = deferred();
    exchangeLoginCredentials.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ token: TOKEN_B });
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
    const loginA = startLogin(auth);
    const loginB = startLogin(auth);
    expect(exchangeLoginCredentials.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { await loginB; });
    await act(async () => {
      if (outcome === "success") late.resolve({ token: TOKEN_A });
      else late.reject(serviceError("invalid-credentials", 401));
    });
    await expect(loginA).resolves.toEqual({ status: "cancelled" });
    expect(getAuthToken()).toBe(TOKEN_B);
    expect(auth().session.user).toEqual(IDENTITY_B);
    expect(getSessionIdentity).toHaveBeenCalledExactlyOnceWith(TOKEN_B, { signal: expect.any(AbortSignal) });
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it.each([TOKEN_A, TOKEN_B])("cancels superseded verification for same-user relogin with %s", async (nextToken) => {
    const { auth } = renderProvider();
    const late = deferred();
    exchangeLoginCredentials.mockResolvedValueOnce({ token: TOKEN_A }).mockResolvedValueOnce({ token: nextToken });
    getSessionIdentity.mockReturnValueOnce(late.promise).mockResolvedValueOnce(IDENTITY_A_REFRESH);
    const loginA = startLogin(auth);
    await act(async () => {});
    const signal = getSessionIdentity.mock.calls[0][1].signal;
    const loginB = startLogin(auth);
    expect(signal.aborted).toBe(true);
    await act(async () => { await loginB; });
    await act(async () => late.resolve(IDENTITY_A));
    await expect(loginA).resolves.toEqual({ status: "cancelled" });
    expect(getAuthToken()).toBe(nextToken);
    expect(auth().session.user).toEqual(IDENTITY_A_REFRESH);
  });

  it.each(["logout", "unmount", "replacement", "same-token completeLogin", "cross-tab clear"])(
    "revokes a pending exchange on %s", async (action) => {
      const { auth, unmount } = renderProvider();
      const late = deferred();
      exchangeLoginCredentials.mockReturnValueOnce(late.promise);
      const login = startLogin(auth);
      await act(async () => {
        if (action === "logout") auth().logout();
        if (action === "unmount") unmount();
        if (action === "replacement") updateTokenAndDispatch(TOKEN_B);
        if (action === "same-token completeLogin") await auth().completeLogin();
        if (action === "cross-tab clear") dispatchStorageEvent({ key: null });
      });
      expect(exchangeLoginCredentials.mock.calls[0][1].signal.aborted).toBe(true);
      await act(async () => late.resolve({ token: TOKEN_A }));
      await expect(login).resolves.toEqual({ status: "cancelled" });
      expect(getAuthToken()).toBe(action === "replacement" ? TOKEN_B : null);
      expect(getSessionIdentity).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0);
    },
  );

  it.each(["logout", "unmount", "replacement"])("revokes pending verification on %s", async (action) => {
    const { auth, unmount } = renderProvider();
    const late = deferred();
    exchangeLoginCredentials.mockResolvedValue({ token: TOKEN_A });
    getSessionIdentity.mockReturnValueOnce(late.promise).mockResolvedValueOnce(IDENTITY_B);
    const login = startLogin(auth);
    await act(async () => {});
    const signal = getSessionIdentity.mock.calls[0][1].signal;
    await act(async () => {
      if (action === "logout") auth().logout();
      if (action === "unmount") unmount();
      if (action === "replacement") updateTokenAndDispatch(TOKEN_B);
    });
    expect(signal.aborted).toBe(true);
    await act(async () => late.reject(serviceError("unauthorized", 401)));
    await expect(login).resolves.toEqual({ status: "cancelled" });
    expect(getAuthToken()).toBe(action === "replacement" ? TOKEN_B : null);
    if (action === "replacement") expect(auth().session.user).toEqual(IDENTITY_B);
    expect(logoutUser).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
  });

  it("does not overwrite a replacement token even before its storage event arrives", async () => {
    const { auth } = renderProvider();
    const late = deferred();
    exchangeLoginCredentials.mockReturnValueOnce(late.promise);
    const login = startLogin(auth);
    setStoredToken(TOKEN_B);
    await act(async () => late.resolve({ token: TOKEN_A }));
    await expect(login).resolves.toEqual({ status: "cancelled" });
    expect(getAuthToken()).toBe(TOKEN_B);
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "network-error", "malformed-response"])(
    "removes its unverified token and reports verification failure for %s", async (category) => {
      const { auth } = renderProvider();
      exchangeLoginCredentials.mockResolvedValue({ token: TOKEN_A });
      getSessionIdentity.mockRejectedValue(serviceError(category));
      const login = startLogin(auth);
      await act(async () => {
        await expect(login).rejects.toMatchObject({ category: "verification-error" });
      });
      expect(getAuthToken()).toBeNull();
      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      expect(getSessionIdentity).toHaveBeenCalledTimes(1);
    },
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("AuthContext session initialization", () => {
  it("renders provider children and the default unauthenticated session", () => {
    const { auth } = renderProvider();

    expect(screen.getByText("Authentication context ready")).toBeInTheDocument();
    expectInitialSession(auth().session);
  });

  it("defaults the session user and error to null and revalidation to false", () => {
    const { auth } = renderProvider();

    expect(auth().session.user).toBeNull();
    expect(auth().session.error).toBeNull();
    expect(auth().session.isRevalidating).toBe(false);
  });

  it("defaults administrator state to not-requested with no identity or error", () => {
    const { auth } = renderProvider();

    expectInitialAdministrator(auth().administrator);
  });

  it("throws a clear developer error when useAuth is called outside its provider", () => {
    expect(() => render(<Probe />)).toThrow(
      "useAuth must be used within an AuthProvider.",
    );
  });

  it("remains unauthenticated and makes no request when there is no token", () => {
    const { auth } = renderProvider();

    expectInitialSession(auth().session);
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it("shows verifying before accepting a stored token's identity response", async () => {
    const request = deferred();
    getSessionIdentity.mockReturnValue(request.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    expect(auth().session.status).toBe("verifying");
    expect(auth().session.user).toBeNull();
    expect(getSessionIdentity).toHaveBeenCalledWith(
      TOKEN_A,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => { request.resolve(IDENTITY_A); });
    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
  });

  it("authenticates only after successful backend identity verification", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    expect(auth().session.user).toEqual(IDENTITY_A);
  });

  it("keeps an administrator profile role separate from administrator authorization", async () => {
    getSessionIdentity.mockResolvedValue(IDENTITY_B);
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    expect(auth().session.user.role).toBe("admin");
    expectInitialAdministrator(auth().administrator);
  });

  it("does not grant administrator access from a stored role value", () => {
    window.localStorage.setItem("role", "admin");
    const { auth } = renderProvider();

    expectInitialAdministrator(auth().administrator);
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it("does not persist the verified identity", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("makes no administrator endpoint or other direct network request", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    expect(getAdminIdentity).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("AuthContext verification failures and retries", () => {
  it("invalidates the current session on a current-session 401", async () => {
    getSessionIdentity.mockRejectedValue(serviceError("unauthorized", 401));
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("unauthenticated"));
    expect(window.localStorage.getItem("token")).toBeNull();
    expect(logoutUser).toHaveBeenCalledTimes(1);
    expectInitialAdministrator(auth().administrator);
  });

  it("preserves the token and does not authenticate on HTTP 403", async () => {
    getSessionIdentity.mockRejectedValue(serviceError("forbidden", 403));
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("unavailable"));
    expect(auth().session.user).toBeNull();
    expect(auth().session.error).toMatchObject({ category: "forbidden" });
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it.each([
    ["network-error", undefined],
    ["server-error", 500],
    ["service-unavailable", 503],
    ["malformed-response", 200],
    ["http-error", 404],
    ["unexpected-status", 201],
  ])("exposes %s as unavailable without removing the token", async (category, status) => {
    getSessionIdentity.mockRejectedValue(serviceError(category, status));
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("unavailable"));
    expect(auth().session.user).toBeNull();
    expect(auth().session.error).toMatchObject({ category });
    expect(auth().session.error.message).not.toContain(TOKEN_A);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("can retry unavailable verification and authenticate after success", async () => {
    getSessionIdentity
      .mockRejectedValueOnce(serviceError("network-error"))
      .mockResolvedValueOnce(IDENTITY_A);
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.status).toBe("unavailable"));

    await act(async () => { await auth().verifySession(); });

    expect(getSessionIdentity).toHaveBeenCalledTimes(2);
    expect(auth().session.status).toBe("authenticated");
    expect(auth().session.user).toEqual(IDENTITY_A);
    expect(auth().session.error).toBeNull();
  });

  it("does not surface cancellation as a network error or remain verifying", async () => {
    getSessionIdentity.mockRejectedValue(serviceError("cancelled"));
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitFor(() => expect(auth().session.status).toBe("unavailable"));
    expect(auth().session.error).toBeNull();
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });
});

describe("AuthContext concurrency protection", () => {
  it("deduplicates concurrent verification requests for the active session", async () => {
    const request = deferred();
    getSessionIdentity.mockReturnValue(request.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    let firstVerification;
    let secondVerification;
    act(() => {
      firstVerification = auth().verifySession();
      secondVerification = auth().verifySession();
    });

    expect(getSessionIdentity).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(IDENTITY_A); });
    await Promise.all([firstVerification, secondVerification]);
    expect(auth().session.status).toBe("authenticated");
  });

  it("ignores a pending success after logout", async () => {
    const request = deferred();
    getSessionIdentity.mockReturnValue(request.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    act(() => auth().logout());
    await act(async () => { request.resolve(IDENTITY_A); });

    expectInitialSession(auth().session);
    expectInitialAdministrator(auth().administrator);
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("ignores a pending failure after logout", async () => {
    const request = deferred();
    getSessionIdentity.mockReturnValue(request.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    act(() => auth().logout());
    await act(async () => { request.reject(serviceError("network-error")); });

    expectInitialSession(auth().session);
    expect(logoutUser).toHaveBeenCalledTimes(1);
  });

  it("verifies the replacement account instead of restoring the old identity", async () => {
    const oldRequest = deferred();
    getSessionIdentity
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(IDENTITY_B);
    const { auth } = renderProvider({ token: TOKEN_A });

    setStoredToken(TOKEN_B);
    await act(async () => { await auth().verifySession(); });

    expect(auth().session.user).toEqual(IDENTITY_B);
    await act(async () => { oldRequest.resolve(IDENTITY_A); });
    expect(auth().session.user).toEqual(IDENTITY_B);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("does not let a late 401 clear a replacement token", async () => {
    const oldRequest = deferred();
    getSessionIdentity
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(IDENTITY_B);
    const { auth } = renderProvider({ token: TOKEN_A });

    setStoredToken(TOKEN_B);
    await act(async () => { await auth().verifySession(); });
    await act(async () => { oldRequest.reject(serviceError("unauthorized", 401)); });

    expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
    expect(auth().session.status).toBe("authenticated");
    expect(auth().session.user).toEqual(IDENTITY_B);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("does not let an old request clear the newer in-flight request reference", async () => {
    const requestA = deferred();
    const requestB = deferred();
    const requestC = deferred();
    getSessionIdentity
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise)
      .mockReturnValueOnce(requestC.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    setStoredToken(TOKEN_B);
    let verifyB;
    act(() => { verifyB = auth().verifySession(); });
    setStoredToken(TOKEN_C);
    let verifyC;
    act(() => { verifyC = auth().verifySession(); });

    await act(async () => { requestB.resolve(IDENTITY_B); });
    await verifyB;
    let verificationAgain;
    act(() => { verificationAgain = auth().verifySession(); });
    expect(getSessionIdentity).toHaveBeenCalledTimes(3);

    await act(async () => { requestC.resolve(IDENTITY_C); });
    await Promise.all([verifyC, verificationAgain]);
    expect(auth().session.user).toEqual(IDENTITY_C);

    await act(async () => { requestA.resolve(IDENTITY_A); });
    expect(auth().session.user).toEqual(IDENTITY_C);
  });

  it("does not apply late responses after provider unmount", async () => {
    const request = deferred();
    const onRender = vi.fn();
    getSessionIdentity.mockReturnValue(request.promise);
    const { auth, unmount } = renderProvider({ token: TOKEN_A, onRender });
    const verify = auth().verifySession();
    unmount();
    const renderCount = onRender.mock.calls.length;

    await act(async () => { request.resolve(IDENTITY_A); });
    await verify;

    expect(onRender).toHaveBeenCalledTimes(renderCount);
  });

  it("handles StrictMode effect replay without applying the aborted request", async () => {
    const firstRequest = deferred();
    const secondRequest = deferred();
    getSessionIdentity
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { auth } = renderProvider({ token: TOKEN_A, strict: true });

    await waitFor(() => expect(getSessionIdentity).toHaveBeenCalledTimes(2));
    expect(getSessionIdentity.mock.calls[0][1].signal.aborted).toBe(true);
    expect(auth().session.status).toBe("verifying");
    await act(async () => { secondRequest.resolve(IDENTITY_A); });

    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    await act(async () => { firstRequest.resolve(IDENTITY_B); });
    expect(auth().session.user).toEqual(IDENTITY_A);
  });
});

describe("AuthContext session lifecycle", () => {
  it("completeLogin verifies the token already stored by the login service", async () => {
    const { auth } = renderProvider();
    setStoredToken(TOKEN_B);

    await act(async () => { await auth().completeLogin(); });

    expect(getSessionIdentity).toHaveBeenCalledWith(
      TOKEN_B,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(auth().session.user).toEqual(IDENTITY_A);
  });

  it("completeLogin clears the previous identity before verifying a new account", async () => {
    const nextRequest = deferred();
    getSessionIdentity
      .mockResolvedValueOnce(IDENTITY_A)
      .mockReturnValueOnce(nextRequest.promise);
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.user).toEqual(IDENTITY_A));
    setStoredToken(TOKEN_B);

    let completion;
    act(() => { completion = auth().completeLogin(); });

    expect(auth().session.status).toBe("verifying");
    expect(auth().session.user).toBeNull();
    expectInitialAdministrator(auth().administrator);
    await act(async () => { nextRequest.resolve(IDENTITY_B); });
    await completion;
    expect(auth().session.user).toEqual(IDENTITY_B);
  });

  it("logout clears session and administrator state and emits the existing logout event once", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.status).toBe("authenticated"));

    act(() => auth().logout());

    expectInitialSession(auth().session);
    expectInitialAdministrator(auth().administrator);
    expect(window.localStorage.getItem("token")).toBeNull();
    expect(logoutUser).toHaveBeenCalledTimes(1);
  });

  it("keeps an authenticated user visible while background verification is pending", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.user).toEqual(IDENTITY_A));
    const refresh = deferred();
    getSessionIdentity.mockReturnValueOnce(refresh.promise);

    let verification;
    act(() => { verification = auth().verifySession(); });

    expect(auth().session.status).toBe("authenticated");
    expect(auth().session.user).toEqual(IDENTITY_A);
    expect(auth().session.isRevalidating).toBe(true);
    await act(async () => { refresh.resolve(IDENTITY_B); });
    await verification;
  });

  it("updates identity after successful background verification", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.user).toEqual(IDENTITY_A));
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A_REFRESH);

    await act(async () => { await auth().verifySession(); });

    expect(auth().session.status).toBe("authenticated");
    expect(auth().session.user).toEqual(IDENTITY_A_REFRESH);
    expect(auth().session.isRevalidating).toBe(false);
    expect(auth().session.error).toBeNull();
  });

  it("retains the verified user after transient background verification failure", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.user).toEqual(IDENTITY_A));
    getSessionIdentity.mockRejectedValueOnce(serviceError("service-unavailable", 503));

    await act(async () => { await auth().verifySession(); });

    expect(auth().session.status).toBe("authenticated");
    expect(auth().session.user).toEqual(IDENTITY_A);
    expect(auth().session.isRevalidating).toBe(false);
    expect(auth().session.error).toMatchObject({ category: "service-unavailable" });
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("invalidates an authenticated session after a current-session background 401", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitFor(() => expect(auth().session.status).toBe("authenticated"));
    getSessionIdentity.mockRejectedValueOnce(serviceError("unauthorized", 401));

    await act(async () => { await auth().verifySession(); });

    expectInitialSession(auth().session);
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("exposes only the intended state and session operations", () => {
    const { auth } = renderProvider();

    expect(Object.keys(auth())).toEqual([
      "session",
      "administrator",
      "verifySession",
      "completeLogin",
      "logout",
      "verifyAdmin",
      "invalidateAdminAuthorization",
      "captureSessionSnapshot",
      "invalidateSession",
      "captureAdminAuthorizationSnapshot",
      "invalidateAdminAuthorizationForRequest",
      "captureAuthenticatedRequest",
      "login",
    ]);
    expect(auth()).not.toHaveProperty("token");
    expect(auth()).not.toHaveProperty("setSession");
    expect(auth()).not.toHaveProperty("setAdministrator");
    expect(Object.isFrozen(auth())).toBe(true);
    expect(Object.isFrozen(auth().session)).toBe(true);
    expect(Object.isFrozen(auth().administrator)).toBe(true);
  });

  it("creates independent session and administrator state for separate providers", () => {
    const states = [];
    render(
      <>
        <AuthProvider><Probe onRender={(auth) => states.push(auth)} /></AuthProvider>
        <AuthProvider><Probe onRender={(auth) => states.push(auth)} /></AuthProvider>
      </>,
    );

    expect(states).toHaveLength(2);
    expect(states[0].session).not.toBe(states[1].session);
    expect(states[0].administrator).not.toBe(states[1].administrator);
  });
});

describe("AuthContext administrator authorization", () => {
  async function waitForAuthenticated(auth, identity = IDENTITY_A) {
    await waitFor(() => {
      expect(auth().session.status).toBe("authenticated");
      expect(auth().session.user).toEqual(identity);
    });
  }

  async function verifyAdmin(auth) {
    await act(async () => { await auth().verifyAdmin(); });
  }

  it("does not request administrator identity during initial or ordinary session verification", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

    await act(async () => { await auth().verifySession(); });

    expect(getAdminIdentity).not.toHaveBeenCalled();
  });

  it("does not request administrator identity without a verified session", async () => {
    const { auth } = renderProvider();
    await act(async () => { await auth().verifyAdmin(); });

    expectInitialAdministrator(auth().administrator);
    expect(getAdminIdentity).not.toHaveBeenCalled();
  });

  it("waits for initial session verification before administrator verification", async () => {
    const profileRequest = deferred();
    getSessionIdentity.mockReturnValue(profileRequest.promise);
    const { auth } = renderProvider({ token: TOKEN_A });

    await act(async () => { await auth().verifyAdmin(); });

    expect(auth().session.status).toBe("verifying");
    expectInitialAdministrator(auth().administrator);
    expect(getAdminIdentity).not.toHaveBeenCalled();

    await act(async () => { profileRequest.resolve(IDENTITY_A); });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);
    expect(getAdminIdentity).toHaveBeenCalledTimes(1);
  });

  it("does not automatically grant administrator access from a profile admin role", async () => {
    getSessionIdentity.mockResolvedValue(IDENTITY_A_ADMIN);
    const { auth } = renderProvider({ token: TOKEN_A });

    await waitForAuthenticated(auth, IDENTITY_A_ADMIN);

    expectInitialAdministrator(auth().administrator);
    expect(getAdminIdentity).not.toHaveBeenCalled();
  });

  it("enters pending state only after explicit administrator verification", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });

    expect(auth().administrator).toEqual({
      status: "pending",
      identity: null,
      error: null,
    });
    expect(getAdminIdentity).toHaveBeenCalledWith(
      TOKEN_A,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;
  });

  it("verifies administrator access even when the profile role is user", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);

    await verifyAdmin(auth);

    expect(auth().administrator).toEqual({
      status: "verified",
      identity: ADMIN_IDENTITY_A,
      error: null,
    });
  });

  describe("AuthContext session-bound invalidation", () => {
    async function waitForAuthenticated(auth, identity = IDENTITY_A) {
      await waitFor(() => {
        expect(auth().session.status).toBe("authenticated");
        expect(auth().session.user).toEqual(identity);
      });
    }

    async function grantAdministrator(auth) {
      await act(async () => { await auth().verifyAdmin(); });
    }

    async function captureAdministratorSnapshots(auth) {
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      return {
        sessionSnapshot,
        authorizationSnapshot: auth().captureAdminAuthorizationSnapshot(sessionSnapshot),
      };
    }

    it("does not capture snapshots for unauthenticated or verifying sessions", async () => {
      const unauthenticated = renderProvider();
      expect(unauthenticated.auth().captureSessionSnapshot()).toBeNull();

      const request = deferred();
      getSessionIdentity.mockReturnValueOnce(request.promise);
      const verifying = renderProvider({ token: TOKEN_A });
      expect(verifying.auth().session.status).toBe("verifying");
      expect(verifying.auth().captureSessionSnapshot()).toBeNull();
      await act(async () => { request.resolve(IDENTITY_A); });
    });

    it("captures a frozen opaque snapshot for a verified session without exposing its token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);

      const snapshot = auth().captureSessionSnapshot();

      expect(snapshot).toEqual({});
      expect(Object.keys(snapshot)).toEqual([]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(TOKEN_A);
      expect(snapshot).not.toHaveProperty("token");
      expect(snapshot).not.toHaveProperty("generation");
    });

    it("does not let snapshot mutation change the authenticated session", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();

      expect(Reflect.set(snapshot, "token", TOKEN_B)).toBe(false);
      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    });

    it("rejects fabricated session snapshots without changing the current session", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);

      expect(auth().invalidateSession({ generation: 1, token: TOKEN_A })).toBe(false);
      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("rejects session snapshots owned by another provider instance", async () => {
      setStoredToken(TOKEN_A);
      const providers = [];
      render(
        <>
          <AuthProvider><Probe onRender={(auth) => { providers[0] = auth; }} /></AuthProvider>
          <AuthProvider><Probe onRender={(auth) => { providers[1] = auth; }} /></AuthProvider>
        </>,
      );
      await waitFor(() => {
        expect(providers[0]?.session.status).toBe("authenticated");
        expect(providers[1]?.session.status).toBe("authenticated");
      });
      const snapshot = providers[0].captureSessionSnapshot();

      expect(providers[1].invalidateSession(snapshot)).toBe(false);
      expect(providers[1].session.user).toEqual(IDENTITY_A);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("invalidates the current session and removes its token for a valid snapshot", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();

      let applied;
      act(() => { applied = auth().invalidateSession(snapshot); });

      expect(applied).toBe(true);
      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      expect(window.localStorage.getItem("token")).toBeNull();
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });

    it("clears administrator authorization during session invalidation", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      await grantAdministrator(auth);
      const snapshot = auth().captureSessionSnapshot();

      act(() => { auth().invalidateSession(snapshot); });

      expectInitialAdministrator(auth().administrator);
      expectInitialSession(auth().session);
    });

    it("aborts pending session and administrator verification on valid invalidation", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const adminRequest = deferred();
      getAdminIdentity.mockReturnValueOnce(adminRequest.promise);
      let adminVerification;
      act(() => { adminVerification = auth().verifyAdmin(); });
      const adminSignal = getAdminIdentity.mock.calls[0][1].signal;
      const sessionRequest = deferred();
      getSessionIdentity.mockReturnValueOnce(sessionRequest.promise);
      let sessionVerification;
      act(() => { sessionVerification = auth().verifySession(); });
      const sessionSignal = getSessionIdentity.mock.calls[1][1].signal;
      const snapshot = auth().captureSessionSnapshot();

      act(() => { auth().invalidateSession(snapshot); });

      expect(sessionSignal.aborted).toBe(true);
      expect(adminSignal.aborted).toBe(true);
      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      await act(async () => {
        sessionRequest.resolve(IDENTITY_A);
        adminRequest.resolve(ADMIN_IDENTITY_A);
      });
      await Promise.all([sessionVerification, adminVerification]);
    });

    it("rejects missing session snapshots without cancelling current requests", async () => {
      const request = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      getSessionIdentity.mockReturnValueOnce(request.promise);
      let verification;
      act(() => { verification = auth().verifySession(); });
      const signal = getSessionIdentity.mock.calls[1][1].signal;

      expect(auth().invalidateSession()).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(auth().session.isRevalidating).toBe(true);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      await act(async () => { request.resolve(IDENTITY_A); });
      await verification;
    });

    it("rejects a snapshot after a replacement login, even for the same user", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const oldSnapshot = auth().captureSessionSnapshot();
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

      await act(async () => { await auth().completeLogin(); });

      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(auth().invalidateSession(oldSnapshot)).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("does not revive snapshots after a session becomes unavailable and is later reverified", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();
      getSessionIdentity
        .mockRejectedValueOnce(serviceError("forbidden", 403))
        .mockResolvedValueOnce(IDENTITY_A);

      await act(async () => { await auth().verifySession(); });
      expect(auth().session.status).toBe("unavailable");
      await act(async () => { await auth().verifySession(); });
      await waitForAuthenticated(auth);

      expect(auth().invalidateSession(snapshot)).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("rejects snapshots captured before a cross-tab token replacement", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const oldSnapshot = auth().captureSessionSnapshot();
      setStoredToken(TOKEN_B);

      expect(auth().invalidateSession(oldSnapshot)).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("protects a replacement token before its storage event is processed", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();
      setStoredToken(TOKEN_B);

      expect(auth().invalidateSession(snapshot)).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(logoutUser).not.toHaveBeenCalled();

      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      act(() => {
        dispatchStorageEvent({ key: "token", oldValue: TOKEN_A, newValue: TOKEN_B });
      });
      await waitForAuthenticated(auth, IDENTITY_B);
    });

    it("makes repeated conditional session invalidation safe", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();

      let firstResult;
      let secondResult;
      act(() => {
        firstResult = auth().invalidateSession(snapshot);
        secondResult = auth().invalidateSession(snapshot);
      });

      expect(firstResult).toBe(true);
      expect(secondResult).toBe(false);
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });

    it("does not invalidate a session from a stale callback after provider unmount", async () => {
      const { auth, unmount } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();
      unmount();

      expect(auth().invalidateSession(snapshot)).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("captures administrator authorization only for a verified grant and session", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const sessionSnapshot = auth().captureSessionSnapshot();

      expect(auth().captureAdminAuthorizationSnapshot(sessionSnapshot)).toBeNull();
      await grantAdministrator(auth);
      const authorizationSnapshot = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);

      expect(authorizationSnapshot).toEqual({});
      expect(Object.isFrozen(authorizationSnapshot)).toBe(true);
      expect(authorizationSnapshot).not.toHaveProperty("token");
      expect(authorizationSnapshot).not.toHaveProperty("generation");
    });

    it("rejects administrator snapshots from another provider", async () => {
      setStoredToken(TOKEN_A);
      const providers = [];
      render(
        <>
          <AuthProvider><Probe onRender={(auth) => { providers[0] = auth; }} /></AuthProvider>
          <AuthProvider><Probe onRender={(auth) => { providers[1] = auth; }} /></AuthProvider>
        </>,
      );
      await waitFor(() => {
        expect(providers[0]?.session.status).toBe("authenticated");
        expect(providers[1]?.session.status).toBe("authenticated");
      });
      const firstSession = providers[0].captureSessionSnapshot();
      const secondSession = providers[1].captureSessionSnapshot();
      await act(async () => {
        await providers[0].verifyAdmin();
        await providers[1].verifyAdmin();
      });
      const firstAuthorization = providers[0].captureAdminAuthorizationSnapshot(firstSession);

      expect(providers[1].invalidateAdminAuthorizationForRequest(
        secondSession,
        firstAuthorization,
      )).toBe(false);
      expect(providers[1].administrator.status).toBe("verified");
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("conditionally denies the matching grant while preserving the user session and token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const { sessionSnapshot, authorizationSnapshot } = await captureAdministratorSnapshots(auth);

      let applied;
      act(() => {
        applied = auth().invalidateAdminAuthorizationForRequest(
          sessionSnapshot,
          authorizationSnapshot,
        );
      });

      expect(applied).toBe(true);
      expect(auth().administrator).toMatchObject({
        status: "denied",
        identity: null,
        error: { category: "forbidden", status: 403 },
      });
      expect(auth().session.status).toBe("authenticated");
      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("rejects missing or fabricated administrator snapshots without revoking access", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      const authorizationSnapshot = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);

      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        undefined,
      )).toBe(false);
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        {},
      )).toBe(false);
      expect(auth().invalidateAdminAuthorizationForRequest(
        null,
        authorizationSnapshot,
      )).toBe(false);
      expect(auth().administrator.status).toBe("verified");
      expect(auth().session.status).toBe("authenticated");
    });

    it("rejects a stale session snapshot without revoking a current grant", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const { sessionSnapshot, authorizationSnapshot } = await captureAdministratorSnapshots(auth);
      await act(async () => { await auth().completeLogin(); });
      await grantAdministrator(auth);
      const currentSession = auth().captureSessionSnapshot();
      const currentAuthorization = auth().captureAdminAuthorizationSnapshot(currentSession);

      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        authorizationSnapshot,
      )).toBe(false);
      expect(auth().administrator.status).toBe("verified");
      expect(auth().invalidateAdminAuthorizationForRequest(
        currentSession,
        currentAuthorization,
      )).toBe(true);
    });

    it("rejects a stale grant snapshot after explicit invalidation and re-verification", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      const oldAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);
      act(() => { auth().invalidateAdminAuthorization(); });
      await grantAdministrator(auth);
      const newAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);

      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        oldAuthorization,
      )).toBe(false);
      expect(auth().administrator.status).toBe("verified");
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        newAuthorization,
      )).toBe(true);
    });

    it("supersedes earlier grant snapshots when fresh administrator verification starts", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      const oldAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);
      const replacementRequest = deferred();
      getAdminIdentity.mockReturnValueOnce(replacementRequest.promise);
      let verification;
      act(() => { verification = auth().verifyAdmin(); });

      expect(auth().administrator.status).toBe("pending");
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        oldAuthorization,
      )).toBe(false);
      await act(async () => { replacementRequest.resolve(ADMIN_IDENTITY_A); });
      await verification;
      const newAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);

      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        oldAuthorization,
      )).toBe(false);
      expect(auth().administrator.status).toBe("verified");
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        newAuthorization,
      )).toBe(true);
    });

    it("invalidates old administrator snapshots after a profile role downgrade", async () => {
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_A_ADMIN);
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth, IDENTITY_A_ADMIN);
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      const oldAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

      await act(async () => { await auth().verifySession(); });
      expectInitialAdministrator(auth().administrator);
      await grantAdministrator(auth);
      const newAuthorization = auth().captureAdminAuthorizationSnapshot(sessionSnapshot);

      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        oldAuthorization,
      )).toBe(false);
      expect(auth().administrator.status).toBe("verified");
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        newAuthorization,
      )).toBe(true);
    });

    it("allows a current-session 401 to invalidate after administrator authorization changes", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const sessionSnapshot = auth().captureSessionSnapshot();
      await grantAdministrator(auth);
      act(() => { auth().invalidateAdminAuthorization(); });
      await grantAdministrator(auth);

      let applied;
      act(() => { applied = auth().invalidateSession(sessionSnapshot); });

      expect(applied).toBe(true);
      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      expect(window.localStorage.getItem("token")).toBeNull();
    });

    it("does not invalidate session or administrator state after provider unmount", async () => {
      const { auth, unmount } = renderProvider({ token: TOKEN_A });
      await waitForAuthenticated(auth);
      const { sessionSnapshot, authorizationSnapshot } = await captureAdministratorSnapshots(auth);
      unmount();

      expect(auth().invalidateSession(sessionSnapshot)).toBe(false);
      expect(auth().invalidateAdminAuthorizationForRequest(
        sessionSnapshot,
        authorizationSnapshot,
      )).toBe(false);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("keeps snapshot capture and invalidation safe under StrictMode", async () => {
      const { auth } = renderProvider({ token: TOKEN_A, strict: true });
      await waitForAuthenticated(auth);
      const snapshot = auth().captureSessionSnapshot();

      expect(snapshot).not.toBeNull();
      let applied;
      act(() => { applied = auth().invalidateSession(snapshot); });

      expect(applied).toBe(true);
      expectInitialSession(auth().session);
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });

    it("preserves explicit logout and same-tab login operations", async () => {
      const { auth } = renderProvider();
      setStoredToken(TOKEN_A);
      await act(async () => { await auth().completeLogin(); });
      expect(auth().session.user).toEqual(IDENTITY_A);

      act(() => { auth().logout(); });
      expectInitialSession(auth().session);
      expect(window.localStorage.getItem("token")).toBeNull();
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });
  });

  describe("AuthContext authenticated request capabilities", () => {
    const USER_API_URL = "http://localhost:5000/api/interviews";
    const ADMIN_API_URL = "http://localhost:5000/api/admin/me";

    function observeRequest(request) {
      return request.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    }

    async function createCapability({
      token = TOKEN_A,
      identity = IDENTITY_A,
      administrator = false,
      verifyAdministrator = administrator,
      strict = false,
    } = {}) {
      getSessionIdentity.mockResolvedValueOnce(identity);
      const { auth, ...renderResult } = renderProvider({ token, strict });
      await waitFor(() => expect(auth().session.status).toBe("authenticated"));
      if (verifyAdministrator) {
        await act(async () => { await auth().verifyAdmin(); });
      }
      return {
        auth,
        capability: auth().captureAuthenticatedRequest({ administrator }),
        ...renderResult,
      };
    }

    function response(status = 200) {
      return new Response("", { status });
    }

    it("does not capture a capability without a verified session", async () => {
      const unauthenticated = renderProvider();
      expect(unauthenticated.auth().captureAuthenticatedRequest()).toBeNull();

      const request = deferred();
      getSessionIdentity.mockReturnValueOnce(request.promise);
      const verifying = renderProvider({ token: TOKEN_A });
      expect(verifying.auth().session.status).toBe("verifying");
      expect(verifying.auth().captureAuthenticatedRequest()).toBeNull();
      await act(async () => { request.resolve(IDENTITY_A); });
    });

    it("captures an immutable capability only after backend session verification", async () => {
      const { capability } = await createCapability();

      expect(capability).toEqual({
        isCurrent: expect.any(Function),
        fetch: expect.any(Function),
      });
      expect(Object.isFrozen(capability)).toBe(true);
      expect(capability.isCurrent()).toBe(true);
    });

    it("does not capture administrator capability from a profile admin role alone", async () => {
      const { auth, capability } = await createCapability({
        identity: IDENTITY_B,
        administrator: true,
        verifyAdministrator: false,
      });

      expect(capability).toBeNull();
      expect(auth().session.user.role).toBe("admin");
      expectInitialAdministrator(auth().administrator);
      expect(getAdminIdentity).not.toHaveBeenCalled();
    });

    it("captures administrator capability only after a verified administrator response", async () => {
      const { auth, capability } = await createCapability({ administrator: true });

      expect(capability).not.toBeNull();
      expect(auth().administrator.status).toBe("verified");
      expect(capability.isCurrent()).toBe(true);
    });

    it("does not capture administrator capabilities while verification is pending", async () => {
      const request = deferred();
      const { auth } = await createCapability();
      getAdminIdentity.mockReturnValueOnce(request.promise);
      act(() => { void auth().verifyAdmin(); });

      expect(auth().administrator.status).toBe("pending");
      expect(auth().captureAuthenticatedRequest({ administrator: true })).toBeNull();
      await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    });

    it.each([
      ["denied", serviceError("forbidden", 403)],
      ["unavailable", serviceError("network-error")],
    ])("does not capture administrator capabilities when authorization is %s", async (status, error) => {
      const { auth } = await createCapability();
      getAdminIdentity.mockRejectedValueOnce(error);
      await act(async () => { await auth().verifyAdmin(); });

      expect(auth().administrator.status).toBe(status);
      expect(auth().captureAuthenticatedRequest({ administrator: true })).toBeNull();
    });

    it("does not expose the token or internal snapshots on a capability", async () => {
      const { capability } = await createCapability({ administrator: true });

      expect(Object.keys(capability)).toEqual(["isCurrent", "fetch"]);
      expect(capability).not.toHaveProperty("token");
      expect(capability).not.toHaveProperty("sessionSnapshot");
      expect(capability).not.toHaveProperty("administratorSnapshot");
      expect(JSON.stringify(capability)).not.toContain(TOKEN_A);
    });

    it("returns null when the stored token no longer matches the verified session", async () => {
      const { auth } = await createCapability();
      setStoredToken(TOKEN_B);

      expect(auth().captureAuthenticatedRequest()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("uses the exact privately captured token and returns the native response", async () => {
      const { capability } = await createCapability();
      const nativeResponse = response();
      fetch.mockResolvedValueOnce(nativeResponse);

      await expect(capability.fetch(USER_API_URL)).resolves.toBe(nativeResponse);

      expect(fetch).toHaveBeenCalledWith(
        USER_API_URL,
        expect.objectContaining({
          headers: expect.any(Headers),
          redirect: "error",
        }),
      );
      expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
    });

    it("rejects a capability after token replacement before dispatch", async () => {
      const { capability } = await createCapability();
      setStoredToken(TOKEN_B);

      await expect(capability.fetch(USER_API_URL)).rejects.toMatchObject({
        name: "AuthenticatedRequestError",
        category: "stale-session",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("invalidates an earlier capability after same-user login completion", async () => {
      const { auth, capability } = await createCapability();
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

      await act(async () => { await auth().completeLogin(); });
      await expect(capability.fetch(USER_API_URL)).rejects.toMatchObject({
        category: "stale-session",
      });
      expect(capability.isCurrent()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("overrides caller Authorization while preserving other headers", async () => {
      const { capability } = await createCapability();
      fetch.mockResolvedValueOnce(response());

      await capability.fetch(USER_API_URL, {
        headers: {
          authorization: "Bearer caller-controlled",
          "X-Request-Id": "request-123",
        },
      });

      const sentHeaders = fetch.mock.calls[0][1].headers;
      expect(sentHeaders.get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
      expect(sentHeaders.get("X-Request-Id")).toBe("request-123");
    });

    it("preserves method, body, signal, and keepalive without mutating caller options", async () => {
      const { capability } = await createCapability();
      const controller = new AbortController();
      const headers = { "Content-Type": "application/json", "X-Request-Id": "save-1" };
      const options = {
        method: "PATCH",
        body: JSON.stringify({ answer: "draft" }),
        signal: controller.signal,
        keepalive: true,
        headers,
      };
      const originalOptions = { ...options };
      fetch.mockResolvedValueOnce(response());

      await capability.fetch(USER_API_URL, options);

      expect(fetch.mock.calls[0][1]).toMatchObject({
        method: "PATCH",
        body: options.body,
        signal: controller.signal,
        keepalive: true,
      });
      expect(fetch.mock.calls[0][1].headers.get("Content-Type")).toBe("application/json");
      expect(fetch.mock.calls[0][1].headers.get("X-Request-Id")).toBe("save-1");
      expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
      expect(options).toEqual(originalOptions);
      expect(headers).toEqual({
        "Content-Type": "application/json",
        "X-Request-Id": "save-1",
      });
    });

    it("rejects a pre-aborted request without dispatch", async () => {
      const { auth, capability } = await createCapability();
      const controller = new AbortController();
      controller.abort();

      await expect(capability.fetch(USER_API_URL, { signal: controller.signal })).rejects.toMatchObject({
        category: "cancelled",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    });

    it("preserves cancellation during an in-flight request without invalidating the session", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability();
      const controller = new AbortController();
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(USER_API_URL, { signal: controller.signal });
      const observed = observeRequest(pending);
      controller.abort();
      const abortError = new Error("synthetic abort");
      abortError.name = "AbortError";
      let outcome;
      await act(async () => {
        request.reject(abortError);
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "cancelled" });
      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("accepts API URLs at the configured origin and path boundary", async () => {
      const { capability } = await createCapability();
      fetch.mockResolvedValue(response());

      await capability.fetch("http://localhost:5000/api");
      await capability.fetch("/api/interviews");
      await capability.fetch("dashboard/stats");

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:5000/api",
        "http://localhost:5000/api/interviews",
        "http://localhost:5000/api/dashboard/stats",
      ]);
    });

    it.each([
      ["unrelated origin", "https://example.com/api/interviews"],
      ["deceptive hostname", "http://localhost.evil:5000/api/interviews"],
      ["incorrect port", "http://localhost:5001/api/interviews"],
      ["unsupported protocol", "https://localhost:5000/api/interviews"],
      ["embedded credentials", "http://user:pass@localhost:5000/api/interviews"],
      ["API path lookalike", "http://localhost:5000/apix/interviews"],
      ["encoded administrator segment", "http://localhost:5000/api/%61dmin/me"],
      ["encoded path separator", "http://localhost:5000/api/%2fadmin/me"],
      ["unsupported URL scheme", "javascript:alert(1)"],
    ])("rejects %s before dispatch", async (_label, url) => {
      const { capability } = await createCapability();

      await expect(capability.fetch(url)).rejects.toMatchObject({
        name: "AuthenticatedRequestError",
        category: "invalid-destination",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects caller redirect-following options before dispatch", async () => {
      const { capability } = await createCapability();

      await expect(capability.fetch(USER_API_URL, { redirect: "follow" })).rejects.toMatchObject({
        category: "invalid-request-options",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects normal capabilities for administrator endpoints", async () => {
      const { capability } = await createCapability();

      await expect(capability.fetch(ADMIN_API_URL)).rejects.toMatchObject({
        category: "invalid-destination",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("restricts administrator capabilities to the administrator path boundary", async () => {
      const { capability } = await createCapability({ administrator: true });
      fetch.mockResolvedValue(response());

      await capability.fetch(ADMIN_API_URL);
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(capability.fetch(USER_API_URL)).rejects.toMatchObject({
        category: "invalid-destination",
      });
      await expect(capability.fetch("http://localhost:5000/api/administer/users")).rejects.toMatchObject({
        category: "invalid-destination",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("conditionally invalidates the current session on HTTP 401", async () => {
      const { auth, capability } = await createCapability();
      fetch.mockResolvedValueOnce(response(401));
      let outcome;

      await act(async () => {
        outcome = await observeRequest(capability.fetch(USER_API_URL));
      });

      expect(outcome.error).toMatchObject({ category: "unauthorized", status: 401 });
      expectInitialSession(auth().session);
      expect(window.localStorage.getItem("token")).toBeNull();
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });

    it("does not let a late 401 invalidate a replacement session", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability();
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(USER_API_URL);
      const observed = observeRequest(pending);
      setStoredToken(TOKEN_B);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      await act(async () => { await auth().completeLogin(); });
      let outcome;
      await act(async () => {
        request.resolve(response(401));
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "stale-session" });
      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(auth().session.user).toEqual(IDENTITY_B);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("dispatches only one logout for concurrent current-session 401 responses", async () => {
      const { auth, capability } = await createCapability();
      fetch.mockResolvedValue(response(401));

      let outcomes;
      await act(async () => {
        outcomes = await Promise.all([
          observeRequest(capability.fetch(USER_API_URL)),
          observeRequest(capability.fetch(USER_API_URL)),
        ]);
      });

      expect(outcomes.every((result) => result.error)).toBe(true);
      expect(outcomes.map((result) => result.error.category).sort()).toEqual([
        "stale-session",
        "unauthorized",
      ]);
      expect(logoutUser).toHaveBeenCalledTimes(1);
      expectInitialSession(auth().session);
    });

    it("conditionally revokes the matching administrator grant on HTTP 403", async () => {
      const { auth, capability } = await createCapability({ administrator: true });
      fetch.mockResolvedValueOnce(response(403));
      let outcome;

      await act(async () => {
        outcome = await observeRequest(capability.fetch(ADMIN_API_URL));
      });
      expect(outcome.error).toMatchObject({ category: "forbidden", status: 403 });
      expect(auth().administrator).toMatchObject({
        status: "denied",
        identity: null,
        error: { category: "forbidden", status: 403 },
      });
      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("does not let a late administrator 403 revoke a newer grant", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability({ administrator: true });
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(ADMIN_API_URL);
      const observed = observeRequest(pending);
      act(() => { auth().invalidateAdminAuthorization(); });
      await act(async () => { await auth().verifyAdmin(); });
      let outcome;
      await act(async () => {
        request.resolve(response(403));
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "stale-session" });
      expect(auth().administrator.status).toBe("verified");
      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("preserves session and administrator authorization for an ordinary endpoint 403", async () => {
      const { auth, capability } = await createCapability({ administrator: true });
      const ordinaryCapability = auth().captureAuthenticatedRequest();
      const nativeResponse = response(403);
      fetch.mockResolvedValueOnce(nativeResponse);

      await expect(ordinaryCapability.fetch(USER_API_URL)).resolves.toBe(nativeResponse);

      expect(auth().session.status).toBe("authenticated");
      expect(auth().administrator.status).toBe("verified");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
      expect(capability.isCurrent()).toBe(true);
    });

    it.each([500, 503])("preserves authentication for HTTP %s", async (status) => {
      const { auth, capability } = await createCapability();
      fetch.mockResolvedValueOnce(response(status));

      await expect(capability.fetch(USER_API_URL)).resolves.toMatchObject({ status });

      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("normalizes network errors without exposing tokens or invalidating authentication", async () => {
      const { auth, capability } = await createCapability();
      fetch.mockRejectedValueOnce(new Error(`private failure ${TOKEN_A}`));

      const request = capability.fetch(USER_API_URL);
      await expect(request).rejects.toMatchObject({
        name: "AuthenticatedRequestError",
        category: "network-error",
      });
      expect(auth().session.status).toBe("authenticated");
      expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("rejects a successful response that arrives after logout", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability();
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(USER_API_URL);
      const observed = observeRequest(pending);
      act(() => { auth().logout(); });
      let outcome;
      await act(async () => {
        request.resolve(response());
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "stale-session" });
      expectInitialSession(auth().session);
    });

    it("rejects a successful response that arrives after account replacement", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability();
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(USER_API_URL);
      const observed = observeRequest(pending);
      setStoredToken(TOKEN_B);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      await act(async () => { await auth().completeLogin(); });
      let outcome;
      await act(async () => {
        request.resolve(response());
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "stale-session" });
      expect(auth().session.user).toEqual(IDENTITY_B);
    });

    it("rejects an administrator response after its grant is replaced", async () => {
      const request = deferred();
      const { auth, capability } = await createCapability({ administrator: true });
      fetch.mockReturnValueOnce(request.promise);
      const pending = capability.fetch(ADMIN_API_URL);
      const observed = observeRequest(pending);
      act(() => { auth().invalidateAdminAuthorization(); });
      await act(async () => { await auth().verifyAdmin(); });
      let outcome;
      await act(async () => {
        request.resolve(response());
        outcome = await observed;
      });

      expect(outcome.error).toMatchObject({ category: "stale-session" });
      expect(auth().administrator.status).toBe("verified");
    });

    it("invalidates old capabilities on cross-tab token replacement", async () => {
      const { auth, capability } = await createCapability();
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      act(() => { updateTokenAndDispatch(TOKEN_B); });
      await waitFor(() => expect(auth().session.user).toEqual(IDENTITY_B));

      expect(capability.isCurrent()).toBe(false);
      await expect(capability.fetch(USER_API_URL)).rejects.toMatchObject({
        category: "stale-session",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("becomes non-current after provider unmount", async () => {
      const { capability, unmount } = await createCapability();
      unmount();

      expect(capability.isCurrent()).toBe(false);
      await expect(capability.fetch(USER_API_URL)).rejects.toMatchObject({
        category: "stale-session",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps normal capabilities current when only administrator authorization changes", async () => {
      const { auth, capability } = await createCapability();
      await act(async () => { await auth().verifyAdmin(); });
      act(() => { auth().invalidateAdminAuthorization(); });

      expect(capability.isCurrent()).toBe(true);
    });

    it("invalidates administrator capabilities when their grant is revoked", async () => {
      const { auth, capability } = await createCapability({ administrator: true });
      act(() => { auth().invalidateAdminAuthorization(); });

      expect(capability.isCurrent()).toBe(false);
      await expect(capability.fetch(ADMIN_API_URL)).rejects.toMatchObject({
        category: "stale-session",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reuses one capability for multiple requests in its unchanged lifecycle", async () => {
      const { capability } = await createCapability();
      fetch.mockResolvedValue(response());

      await capability.fetch(USER_API_URL);
      await capability.fetch("http://localhost:5000/api/dashboard/stats");

      expect(capability.isCurrent()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([, options]) =>
        options.headers.get("Authorization") === `Bearer ${TOKEN_A}`
      )).toBe(true);
    });

    it("remains safe under StrictMode", async () => {
      const { capability } = await createCapability({ strict: true });
      fetch.mockResolvedValueOnce(response());

      expect(capability.isCurrent()).toBe(true);
      await capability.fetch(USER_API_URL);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
    });
  });

  describe("AuthContext cross-tab storage synchronization", () => {
    async function waitForUser(auth, identity = IDENTITY_A) {
      await waitFor(() => {
        expect(auth().session.status).toBe("authenticated");
        expect(auth().session.user).toEqual(identity);
      });
    }

    it("clears an authenticated session after the stored token is removed", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);

      act(() => {
        updateTokenAndDispatch(null, { newValue: null });
      });

      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
    });

    it("clears administrator authorization after cross-tab logout without redispatching logout", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      await act(async () => { await auth().verifyAdmin(); });

      act(() => {
        updateTokenAndDispatch(null, { newValue: null });
      });

      expectInitialAdministrator(auth().administrator);
      expectInitialSession(auth().session);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("aborts pending session verification after cross-tab logout", async () => {
      const request = deferred();
      getSessionIdentity.mockReturnValueOnce(request.promise);
      const { auth } = renderProvider({ token: TOKEN_A });
      const signal = getSessionIdentity.mock.calls[0][1].signal;

      act(() => {
        updateTokenAndDispatch(null, { newValue: null });
      });

      expect(signal.aborted).toBe(true);
      expectInitialSession(auth().session);
      await act(async () => { request.resolve(IDENTITY_A); });
      expectInitialSession(auth().session);
    });

    it("aborts pending administrator verification after cross-tab logout", async () => {
      const request = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getAdminIdentity.mockReturnValueOnce(request.promise);
      let verification;
      act(() => { verification = auth().verifyAdmin(); });
      const signal = getAdminIdentity.mock.calls[0][1].signal;

      act(() => {
        updateTokenAndDispatch(null, { newValue: null });
      });

      expect(signal.aborted).toBe(true);
      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
      await verification;
      expectInitialAdministrator(auth().administrator);
    });

    it("does not restore authentication from a late success after cross-tab logout", async () => {
      const request = deferred();
      getSessionIdentity.mockReturnValueOnce(request.promise);
      const { auth } = renderProvider({ token: TOKEN_A });

      act(() => {
        updateTokenAndDispatch(null, { newValue: null });
      });
      await act(async () => { request.resolve(IDENTITY_A); });

      expectInitialSession(auth().session);
    });

    it("starts replacement verification without exposing the previous identity", async () => {
      const replacementRequest = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      await act(async () => { await auth().verifyAdmin(); });
      getSessionIdentity.mockReturnValueOnce(replacementRequest.promise);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });

      expect(auth().session.status).toBe("verifying");
      expect(auth().session.user).toBeNull();
      expectInitialAdministrator(auth().administrator);
      expect(getSessionIdentity.mock.calls.at(-1)[0]).toBe(TOKEN_B);
      await act(async () => { replacementRequest.resolve(IDENTITY_B); });
      await waitForUser(auth, IDENTITY_B);
    });

    it("authenticates a replacement token only after its profile verifies", async () => {
      const replacementRequest = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockReturnValueOnce(replacementRequest.promise);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });

      expect(auth().session.status).toBe("verifying");
      expect(auth().session.user).toBeNull();
      await act(async () => { replacementRequest.resolve(IDENTITY_B); });
      await waitForUser(auth, IDENTITY_B);
    });

    it("aborts old session verification when a replacement token arrives", async () => {
      const oldRequest = deferred();
      getSessionIdentity
        .mockReturnValueOnce(oldRequest.promise)
        .mockResolvedValueOnce(IDENTITY_B);
      const { auth } = renderProvider({ token: TOKEN_A });
      const oldSignal = getSessionIdentity.mock.calls[0][1].signal;

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });

      expect(oldSignal.aborted).toBe(true);
      await waitForUser(auth, IDENTITY_B);
      await act(async () => { oldRequest.resolve(IDENTITY_A); });
      expect(auth().session.user).toEqual(IDENTITY_B);
    });

    it("aborts old administrator verification when a replacement token arrives", async () => {
      const adminRequest = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getAdminIdentity.mockReturnValueOnce(adminRequest.promise);
      let verification;
      act(() => { verification = auth().verifyAdmin(); });
      const adminSignal = getAdminIdentity.mock.calls[0][1].signal;
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });

      expect(adminSignal.aborted).toBe(true);
      await waitForUser(auth, IDENTITY_B);
      await act(async () => { adminRequest.resolve(ADMIN_IDENTITY_A); });
      await verification;
      expectInitialAdministrator(auth().administrator);
    });

    it("does not grant administrator access from a replacement admin profile role", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });
      await waitForUser(auth, IDENTITY_B);

      expectInitialAdministrator(auth().administrator);
      expect(getAdminIdentity).not.toHaveBeenCalled();
    });

    it("reports replacement verification failure and preserves the replacement token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockRejectedValueOnce(serviceError("service-unavailable", 503));

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });
      await waitFor(() => expect(auth().session.status).toBe("unavailable"));

      expect(auth().session.user).toBeNull();
      expect(auth().session.error).toMatchObject({ category: "service-unavailable" });
      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
    });

    it("does not let a late old-session 401 remove the replacement token", async () => {
      const oldRequest = deferred();
      getSessionIdentity
        .mockReturnValueOnce(oldRequest.promise)
        .mockResolvedValueOnce(IDENTITY_B);
      const { auth } = renderProvider({ token: TOKEN_A });

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });
      await waitForUser(auth, IDENTITY_B);
      await act(async () => { oldRequest.reject(serviceError("unauthorized", 401)); });

      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(auth().session.user).toEqual(IDENTITY_B);
      expect(logoutUser).not.toHaveBeenCalled();
    });

    it("verifies only the most recent token after rapid replacements", async () => {
      const requestB = deferred();
      const requestC = deferred();
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity
        .mockReturnValueOnce(requestB.promise)
        .mockReturnValueOnce(requestC.promise);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
      });
      const signalB = getSessionIdentity.mock.calls[1][1].signal;
      act(() => {
        updateTokenAndDispatch(TOKEN_C);
      });
      const signalC = getSessionIdentity.mock.calls[2][1].signal;

      expect(signalB.aborted).toBe(true);
      expect(signalC.aborted).toBe(false);
      expect(auth().session.status).toBe("verifying");
      await act(async () => { requestB.resolve(IDENTITY_B); });
      await act(async () => { requestC.resolve(IDENTITY_C); });
      await waitForUser(auth, IDENTITY_C);
      expect(window.localStorage.getItem("token")).toBe(TOKEN_C);
    });

    it("ignores unrelated localStorage keys and role changes", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      const requestCount = getSessionIdentity.mock.calls.length;

      act(() => {
        window.localStorage.setItem("preferences", "dark");
        dispatchStorageEvent({ key: "preferences", newValue: "dark" });
        window.localStorage.setItem("role", "admin");
        dispatchStorageEvent({ key: "role", newValue: "admin" });
      });

      expect(auth().session.user).toEqual(IDENTITY_A);
      expectInitialAdministrator(auth().administrator);
      expect(getSessionIdentity).toHaveBeenCalledTimes(requestCount);
      expect(getAdminIdentity).not.toHaveBeenCalled();
    });

    it("ignores sessionStorage events", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      const requestCount = getSessionIdentity.mock.calls.length;
      window.sessionStorage.setItem("token", TOKEN_B);

      act(() => {
        dispatchStorageEvent({
          key: "token",
          oldValue: TOKEN_A,
          newValue: TOKEN_B,
          storageArea: window.sessionStorage,
        });
      });

      expect(auth().session.user).toEqual(IDENTITY_A);
      expect(getSessionIdentity).toHaveBeenCalledTimes(requestCount);
    });

    it("handles localStorage.clear() by reading the actual missing token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);

      act(() => {
        window.localStorage.clear();
        dispatchStorageEvent({ key: null, oldValue: null, newValue: null });
      });

      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
    });

    it("does not reverify when a storage event leaves the actual token unchanged", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);

      act(() => {
        dispatchStorageEvent({
          key: "token",
          oldValue: TOKEN_A,
          newValue: TOKEN_B,
        });
      });

      expect(getSessionIdentity).toHaveBeenCalledTimes(1);
      expect(auth().session.user).toEqual(IDENTITY_A);
    });

    it("does not duplicate verification for repeated events reporting the same actual token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

      act(() => {
        updateTokenAndDispatch(TOKEN_B);
        dispatchStorageEvent({ key: "token", oldValue: TOKEN_A, newValue: TOKEN_B });
      });
      await waitForUser(auth, IDENTITY_B);

      expect(getSessionIdentity).toHaveBeenCalledTimes(2);
    });

    it("uses the actual replacement token when processing a delayed logout event", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

      act(() => {
        setStoredToken(TOKEN_B);
        dispatchStorageEvent({ key: "token", oldValue: TOKEN_A, newValue: null });
      });
      await waitForUser(auth, IDENTITY_B);

      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
    });

    it("does not restore an older token from a delayed login event", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      act(() => { updateTokenAndDispatch(TOKEN_B); });
      await waitForUser(auth, IDENTITY_B);
      const requestCount = getSessionIdentity.mock.calls.length;

      act(() => {
        dispatchStorageEvent({ key: "token", oldValue: null, newValue: TOKEN_A });
      });

      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(auth().session.user).toEqual(IDENTITY_B);
      expect(getSessionIdentity).toHaveBeenCalledTimes(requestCount);
    });

    it("does not treat a delayed clear event as logout when a token is currently stored", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      act(() => { updateTokenAndDispatch(TOKEN_B); });
      await waitForUser(auth, IDENTITY_B);

      act(() => {
        dispatchStorageEvent({ key: null, oldValue: null, newValue: null });
      });

      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(auth().session.user).toEqual(IDENTITY_B);
    });

    it("does not trust event.newValue over the actual stored token", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

      act(() => {
        setStoredToken(TOKEN_B);
        dispatchStorageEvent({ key: "token", oldValue: TOKEN_A, newValue: TOKEN_C });
      });
      await waitForUser(auth, IDENTITY_B);

      expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
      expect(getSessionIdentity.mock.calls.at(-1)[0]).toBe(TOKEN_B);
    });

    it("removes the storage listener during provider cleanup", () => {
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      const { unmount } = renderProvider();
      const registration = addListener.mock.calls.find(([type]) => type === "storage");

      unmount();

      expect(registration).toBeDefined();
      expect(removeListener).toHaveBeenCalledWith("storage", registration[1]);
      addListener.mockRestore();
      removeListener.mockRestore();
    });

    it("does not process storage events after provider unmount", async () => {
      const { auth, unmount } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);
      const requestCount = getSessionIdentity.mock.calls.length;
      unmount();

      setStoredToken(TOKEN_B);
      dispatchStorageEvent({ key: "token", oldValue: TOKEN_A, newValue: TOKEN_B });

      expect(getSessionIdentity).toHaveBeenCalledTimes(requestCount);
    });

    it("cleans up StrictMode replay listeners and processes a replacement once", async () => {
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      const { auth, unmount } = renderProvider({ token: TOKEN_A, strict: true });
      await waitForUser(auth);
      const registrations = addListener.mock.calls.filter(([type]) => type === "storage");
      const replayRemovals = removeListener.mock.calls.filter(([type]) => type === "storage");
      expect(registrations).toHaveLength(2);
      expect(replayRemovals).toHaveLength(1);

      getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
      act(() => { updateTokenAndDispatch(TOKEN_B); });
      await waitForUser(auth, IDENTITY_B);
      expect(getSessionIdentity).toHaveBeenCalledTimes(3);

      unmount();
      const finalRemovals = removeListener.mock.calls.filter(([type]) => type === "storage");
      expect(finalRemovals).toHaveLength(2);
      expect(finalRemovals.map(([, listener]) => listener)).toEqual(
        registrations.map(([, listener]) => listener),
      );
      addListener.mockRestore();
      removeListener.mockRestore();
    });

    it("keeps the existing same-tab login completion behavior", async () => {
      const { auth } = renderProvider();
      setStoredToken(TOKEN_B);

      await act(async () => { await auth().completeLogin(); });

      expect(getSessionIdentity).toHaveBeenCalledWith(
        TOKEN_B,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(auth().session.user).toEqual(IDENTITY_A);
    });

    it("keeps the existing same-tab logout behavior without recursive dispatch", async () => {
      const { auth } = renderProvider({ token: TOKEN_A });
      await waitForUser(auth);

      act(() => auth().logout());

      expectInitialSession(auth().session);
      expectInitialAdministrator(auth().administrator);
      expect(window.localStorage.getItem("token")).toBeNull();
      expect(logoutUser).toHaveBeenCalledTimes(1);
    });

    it("does not expose raw tokens or privilege-granting setters", () => {
      const { auth } = renderProvider({ token: TOKEN_A });

      expect(Object.keys(auth())).toContain("invalidateAdminAuthorization");
      expect(auth()).not.toHaveProperty("token");
      expect(auth()).not.toHaveProperty("setSession");
      expect(auth()).not.toHaveProperty("setAdministrator");
      expect(auth()).not.toHaveProperty("grantAdministrator");
    });
  });

  it("accepts only an administrator identity matching the verified session user", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockResolvedValueOnce(ADMIN_IDENTITY_A);

    await verifyAdmin(auth);

    expect(auth().administrator.status).toBe("verified");
    expect(auth().administrator.identity.userId).toBe(IDENTITY_A.id);
    expect(auth().administrator.identity.role).toBe("admin");
  });

  it("rejects a valid administrator identity for a different user", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockResolvedValueOnce(ADMIN_IDENTITY_B);

    await verifyAdmin(auth);

    expect(auth().administrator.status).toBe("unavailable");
    expect(auth().administrator.identity).toBeNull();
    expect(auth().administrator.error).toMatchObject({ category: "identity-mismatch" });
    expect(auth().session.user).toEqual(IDENTITY_A);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("does not persist administrator identity or role", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);

    await verifyAdmin(auth);

    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("clears a previous grant while explicit revalidation is pending", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);
    const request = deferred();
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });

    expect(auth().administrator).toEqual({
      status: "pending",
      identity: null,
      error: null,
    });
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;
  });

  it("marks administrator access denied on 403 without ending the user session", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockRejectedValueOnce(serviceError("forbidden", 403));

    await verifyAdmin(auth);

    expect(auth().administrator.status).toBe("denied");
    expect(auth().administrator.identity).toBeNull();
    expect(auth().administrator.error).toMatchObject({ category: "forbidden" });
    expect(auth().session.status).toBe("authenticated");
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("invalidates the current session on administrator 401", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockRejectedValueOnce(serviceError("unauthorized", 401));

    await verifyAdmin(auth);

    expectInitialSession(auth().session);
    expectInitialAdministrator(auth().administrator);
    expect(window.localStorage.getItem("token")).toBeNull();
    expect(logoutUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["server-error", 500],
    ["service-unavailable", 503],
    ["network-error", undefined],
    ["malformed-response", 200],
    ["http-error", 404],
    ["unexpected-status", 201],
  ])("marks administrator %s as unavailable without ending the session", async (category, status) => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockRejectedValueOnce(serviceError(category, status));

    await verifyAdmin(auth);

    expect(auth().administrator.status).toBe("unavailable");
    expect(auth().administrator.identity).toBeNull();
    expect(auth().administrator.error).toMatchObject({ category });
    expect(auth().administrator.error.message).not.toContain(TOKEN_A);
    expect(auth().session.status).toBe("authenticated");
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it.each([
    ["forbidden", "denied"],
    ["network-error", "unavailable"],
  ])("allows retry after administrator %s", async (category, initialStatus) => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity
      .mockRejectedValueOnce(serviceError(category))
      .mockResolvedValueOnce(ADMIN_IDENTITY_A);

    await verifyAdmin(auth);
    expect(auth().administrator.status).toBe(initialStatus);

    await verifyAdmin(auth);
    expect(auth().administrator.status).toBe("verified");
    expect(getAdminIdentity).toHaveBeenCalledTimes(2);
  });

  it("does not leave administrator state pending after cancellation", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockRejectedValueOnce(serviceError("cancelled"));

    await verifyAdmin(auth);

    expectInitialAdministrator(auth().administrator);
    expect(auth().session.status).toBe("authenticated");
  });

  it("deduplicates concurrent administrator verification requests", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let firstVerification;
    let secondVerification;
    act(() => {
      firstVerification = auth().verifyAdmin();
      secondVerification = auth().verifyAdmin();
    });

    expect(getAdminIdentity).toHaveBeenCalledTimes(1);
    expect(auth().administrator.status).toBe("pending");
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await Promise.all([firstVerification, secondVerification]);
    expect(auth().administrator.status).toBe("verified");
  });

  it("ignores an administrator success after logout", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    act(() => auth().logout());
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;

    expectInitialSession(auth().session);
    expectInitialAdministrator(auth().administrator);
  });

  it("ignores an administrator failure after logout", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    act(() => auth().logout());
    await act(async () => { request.reject(serviceError("forbidden", 403)); });
    await verification;

    expectInitialAdministrator(auth().administrator);
    expectInitialSession(auth().session);
  });

  it("does not restore administrator access after account replacement", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    setStoredToken(TOKEN_B);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
    await act(async () => { await auth().completeLogin(); });
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;

    expect(auth().session.user).toEqual(IDENTITY_B);
    expectInitialAdministrator(auth().administrator);
  });

  it("does not let a late administrator 401 clear a replacement token", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);
    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    setStoredToken(TOKEN_B);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
    await act(async () => { await auth().completeLogin(); });
    await act(async () => { request.reject(serviceError("unauthorized", 401)); });
    await verification;

    expect(window.localStorage.getItem("token")).toBe(TOKEN_B);
    expect(auth().session.user).toEqual(IDENTITY_B);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("does not let a late administrator 403 deny a newer session", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);
    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    setStoredToken(TOKEN_B);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);
    await act(async () => { await auth().completeLogin(); });
    await act(async () => { request.reject(serviceError("forbidden", 403)); });
    await verification;

    expect(auth().session.user).toEqual(IDENTITY_B);
    expectInitialAdministrator(auth().administrator);
  });

  it("does not let an old request clear the newer administrator request reference", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);

    let oldVerification;
    act(() => { oldVerification = auth().verifyAdmin(); });
    act(() => auth().invalidateAdminAuthorization());
    let newVerification;
    act(() => { newVerification = auth().verifyAdmin(); });
    await act(async () => { oldRequest.reject(serviceError("forbidden", 403)); });
    await oldVerification;

    let deduplicatedVerification;
    act(() => { deduplicatedVerification = auth().verifyAdmin(); });
    expect(getAdminIdentity).toHaveBeenCalledTimes(2);
    expect(auth().administrator.status).toBe("pending");
    await act(async () => { newRequest.resolve(ADMIN_IDENTITY_A); });
    await Promise.all([newVerification, deduplicatedVerification]);
    expect(auth().administrator.status).toBe("verified");
  });

  it("keeps session and administrator request references independent", async () => {
    const profileRefresh = deferred();
    const adminRequest = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getSessionIdentity.mockReturnValueOnce(profileRefresh.promise);
    getAdminIdentity.mockReturnValueOnce(adminRequest.promise);

    let sessionVerification;
    let adminVerification;
    act(() => {
      sessionVerification = auth().verifySession();
      adminVerification = auth().verifyAdmin();
    });
    expect(auth().session.isRevalidating).toBe(true);
    expect(auth().administrator.status).toBe("pending");

    let duplicateSession;
    let duplicateAdmin;
    act(() => {
      duplicateSession = auth().verifySession();
      duplicateAdmin = auth().verifyAdmin();
    });
    expect(getSessionIdentity).toHaveBeenCalledTimes(2);
    expect(getAdminIdentity).toHaveBeenCalledTimes(1);

    await act(async () => {
      profileRefresh.resolve(IDENTITY_A);
      adminRequest.resolve(ADMIN_IDENTITY_A);
    });
    await Promise.all([sessionVerification, adminVerification, duplicateSession, duplicateAdmin]);
    expect(auth().session.status).toBe("authenticated");
    expect(auth().administrator.status).toBe("verified");
  });

  it("does not apply administrator results after provider unmount", async () => {
    const request = deferred();
    const onRender = vi.fn();
    const { auth, unmount } = renderProvider({ token: TOKEN_A, onRender });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);
    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    unmount();
    const renderCount = onRender.mock.calls.length;

    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;

    expect(onRender).toHaveBeenCalledTimes(renderCount);
  });

  it("keeps explicit administrator verification safe under StrictMode", async () => {
    const { auth } = renderProvider({ token: TOKEN_A, strict: true });
    await waitForAuthenticated(auth);
    const request = deferred();
    getAdminIdentity.mockReturnValueOnce(request.promise);

    let verification;
    act(() => { verification = auth().verifyAdmin(); });
    expect(getAdminIdentity).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;
    expect(auth().administrator.status).toBe("verified");
  });

  it("invalidates a verified administrator without ending the user session", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);

    act(() => auth().invalidateAdminAuthorization());

    expectInitialAdministrator(auth().administrator);
    expect(auth().session.status).toBe("authenticated");
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
    expect(logoutUser).not.toHaveBeenCalled();
  });

  it("prevents pending administrator verification from restoring an invalidated grant", async () => {
    const request = deferred();
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getAdminIdentity.mockReturnValueOnce(request.promise);
    let verification;
    act(() => { verification = auth().verifyAdmin(); });

    act(() => auth().invalidateAdminAuthorization());
    await act(async () => { request.resolve(ADMIN_IDENTITY_A); });
    await verification;

    expectInitialAdministrator(auth().administrator);
    expect(auth().session.status).toBe("authenticated");
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("resets administrator authorization when the session is invalidated", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);

    act(() => auth().logout());

    expectInitialAdministrator(auth().administrator);
    expectInitialSession(auth().session);
  });

  it("revokes administrator access when profile revalidation reports a role downgrade", async () => {
    const adminRequest = deferred();
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A_ADMIN);
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth, IDENTITY_A_ADMIN);
    getAdminIdentity.mockReturnValueOnce(adminRequest.promise);
    let adminVerification;
    act(() => { adminVerification = auth().verifyAdmin(); });
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

    await act(async () => { await auth().verifySession(); });

    expect(auth().session.user).toEqual(IDENTITY_A);
    expectInitialAdministrator(auth().administrator);
    await act(async () => { adminRequest.resolve(ADMIN_IDENTITY_A); });
    await adminVerification;
    expectInitialAdministrator(auth().administrator);
  });

  it("does not automatically grant administrator access after a profile role upgrade", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A_ADMIN);

    await act(async () => { await auth().verifySession(); });

    expect(auth().session.user.role).toBe("admin");
    expectInitialAdministrator(auth().administrator);
    expect(getAdminIdentity).not.toHaveBeenCalled();
  });

  it("prevents a pending administrator result from restoring access after a role downgrade", async () => {
    const adminRequest = deferred();
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A_ADMIN);
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth, IDENTITY_A_ADMIN);
    getAdminIdentity.mockReturnValueOnce(adminRequest.promise);
    let adminVerification;
    act(() => { adminVerification = auth().verifyAdmin(); });
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_A);

    await act(async () => { await auth().verifySession(); });
    await act(async () => { adminRequest.resolve(ADMIN_IDENTITY_A); });
    await adminVerification;

    expect(auth().session.user.role).toBe("user");
    expectInitialAdministrator(auth().administrator);
  });

  it("fails closed and clears old administrator authorization on profile identity mismatch", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);
    getSessionIdentity.mockResolvedValueOnce(IDENTITY_B);

    await act(async () => { await auth().verifySession(); });

    expect(auth().session.status).toBe("unavailable");
    expect(auth().session.user).toBeNull();
    expect(auth().session.error).toMatchObject({ category: "identity-mismatch" });
    expectInitialAdministrator(auth().administrator);
    expect(window.localStorage.getItem("token")).toBe(TOKEN_A);
  });

  it("can establish a fresh administrator grant after explicit invalidation", async () => {
    const { auth } = renderProvider({ token: TOKEN_A });
    await waitForAuthenticated(auth);
    await verifyAdmin(auth);
    act(() => auth().invalidateAdminAuthorization());

    getAdminIdentity.mockResolvedValueOnce(ADMIN_IDENTITY_A);
    await verifyAdmin(auth);

    expect(auth().administrator.status).toBe("verified");
    expect(auth().administrator.identity).toEqual(ADMIN_IDENTITY_A);
  });

  it("keeps administrator controls private and returns current state when no session exists", async () => {
    const { auth } = renderProvider();
    const result = await auth().verifyAdmin();

    expect(result).toEqual(auth().administrator);
    expect(Object.keys(auth())).toEqual([
      "session",
      "administrator",
      "verifySession",
      "completeLogin",
      "logout",
      "verifyAdmin",
      "invalidateAdminAuthorization",
      "captureSessionSnapshot",
      "invalidateSession",
      "captureAdminAuthorizationSnapshot",
      "invalidateAdminAuthorizationForRequest",
      "captureAuthenticatedRequest",
      "login",
    ]);
    expect(auth()).not.toHaveProperty("token");
    expect(auth()).not.toHaveProperty("setAdministrator");
    expect(auth()).not.toHaveProperty("grantAdministrator");
  });
});
