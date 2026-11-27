import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getAdminIdentity } from "../services/adminService.js";
import { exchangeLoginCredentials, getAuthToken, getSessionIdentity, logoutUser } from "../services/authService.js";

const AuthContext = createContext(null);
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const TOKEN_STORAGE_KEY = "token";
const AUTHENTICATED_API_BASE_URL = "http://localhost:5000/api";
const AUTHENTICATED_API_BASE = new URL(`${AUTHENTICATED_API_BASE_URL}/`);
const AUTHENTICATED_API_ORIGIN = AUTHENTICATED_API_BASE.origin;

const AUTHENTICATED_REQUEST_ERROR_MESSAGES = Object.freeze({
  "stale-session": "The authentication session for this request is no longer current.",
  "invalid-destination": "The authenticated request URL is outside the permitted API destination.",
  "invalid-request-options": "The authenticated request options are invalid or unsupported.",
  cancelled: "The authenticated request was cancelled.",
  unauthorized: "The authentication session is no longer valid.",
  forbidden: "Administrator access is no longer authorized.",
  "network-error": "The authenticated request could not reach the API.",
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  "missing-token": "An authentication token is required to verify the current session.",
  "invalid-token": "The authentication token is invalid.",
  forbidden: "Access to the current session was denied.",
  "network-error": "Could not connect to PrepX. Please try again.",
  "server-error": "The authentication service encountered an internal error.",
  "service-unavailable": "The authentication service is temporarily unavailable.",
  "http-error": "The session identity request could not be completed.",
  "unexpected-status": "The session identity endpoint returned an unexpected response.",
  "malformed-response": "The session identity response was invalid.",
  "identity-mismatch": "The verified account identity changed unexpectedly.",
  "verification-error": "The current session could not be verified.",
});

const SAFE_ADMIN_ERROR_MESSAGES = Object.freeze({
  forbidden: "Administrator access is required.",
  "network-error": "Could not connect to PrepX. Please try again.",
  "server-error": "The administrator service encountered an internal error.",
  "service-unavailable": "The administrator service is temporarily unavailable.",
  "http-error": "The administrator identity request could not be completed.",
  "unexpected-status": "The administrator identity endpoint returned an unexpected response.",
  "malformed-response": "The administrator identity response was invalid.",
  "identity-mismatch": "The administrator identity did not match the verified session.",
  "verification-error": "Administrator access could not be verified.",
});

function createSession(status, user = null, error = null, isRevalidating = false) {
  return Object.freeze({ status, user, error, isRevalidating });
}

function createInitialSession(token) {
  return token
    ? createSession("verifying")
    : createSession("unauthenticated");
}

function createInitialAdministrator() {
  return Object.freeze({
    status: "not-requested",
    identity: null,
    error: null,
  });
}

function createSafeError(error, messages = SAFE_ERROR_MESSAGES) {
  const category = Object.hasOwn(messages, error?.category)
    ? error.category
    : "verification-error";
  const safeError = {
    category,
    message: messages[category],
  };
  if (Number.isInteger(error?.status)) safeError.status = error.status;
  return Object.freeze(safeError);
}

function createVerifiedUser(identity) {
  return Object.freeze({
    id: identity.id,
    name: identity.name,
    email: identity.email,
    role: identity.role,
  });
}

function isSameObjectId(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    OBJECT_ID_PATTERN.test(left) &&
    OBJECT_ID_PATTERN.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function isSnapshotReference(snapshot) {
  return (
    snapshot !== null &&
    (typeof snapshot === "object" || typeof snapshot === "function")
  );
}

function createAuthenticatedRequestError(category, status) {
  const error = new Error(
    AUTHENTICATED_REQUEST_ERROR_MESSAGES[category] ||
    AUTHENTICATED_REQUEST_ERROR_MESSAGES["network-error"],
  );
  error.name = "AuthenticatedRequestError";
  error.category = category;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function parseAuthenticatedRequestUrl(value, administrator) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  let url;
  try {
    url = new URL(value instanceof URL ? value.href : value, AUTHENTICATED_API_BASE);
  } catch {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  if (
    url.protocol !== "http:" ||
    url.origin !== AUTHENTICATED_API_ORIGIN ||
    url.username ||
    url.password
  ) {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  let pathSegments;
  try {
    pathSegments = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  if (
    pathSegments[0]?.toLowerCase() !== "api" ||
    pathSegments.some((segment, index) => (
      segment.includes("/") ||
      segment.includes("\\") ||
      segment === "." ||
      segment === ".." ||
      /%[0-9a-f]{2}/i.test(segment) ||
      (segment === "" && index !== pathSegments.length - 1)
    ))
  ) {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  const isAdministratorPath = pathSegments[1]?.toLowerCase() === "admin";
  if (administrator ? !isAdministratorPath : isAdministratorPath) {
    throw createAuthenticatedRequestError("invalid-destination");
  }

  return url;
}

function prepareAuthenticatedRequestOptions(options, token) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    (options.redirect !== undefined && options.redirect !== "error")
  ) {
    throw createAuthenticatedRequestError("invalid-request-options");
  }

  try {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return {
      ...options,
      headers,
      redirect: "error",
    };
  } catch {
    throw createAuthenticatedRequestError("invalid-request-options");
  }
}

function isValidAdministratorIdentity(identity) {
  return (
    identity !== null &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    typeof identity.userId === "string" &&
    OBJECT_ID_PATTERN.test(identity.userId) &&
    identity.role === "admin"
  );
}

export function AuthProvider({ children }) {
  const [initialToken] = useState(() => getAuthToken());
  const [session, setSessionState] = useState(() => createInitialSession(initialToken));
  const [administrator, setAdministratorState] = useState(createInitialAdministrator);
  const sessionRef = useRef(session);
  const administratorRef = useRef(administrator);
  const currentTokenRef = useRef(initialToken);
  const generationRef = useRef(initialToken ? 1 : 0);
  const verifiedSessionRef = useRef(null);
  const sessionSnapshotsRef = useRef(new WeakMap());
  const administratorSnapshotsRef = useRef(new WeakMap());
  const adminAuthorizationGenerationRef = useRef(0);
  const inFlightRef = useRef(null);
  const loginAttemptRef = useRef(null);
  const adminRequestRef = useRef(null);
  const adminRequestGenerationRef = useRef(0);
  const verifySessionRef = useRef(null);
  const mountedRef = useRef(true);
  const dispatchingLogoutRef = useRef(false);

  const setSession = useCallback((nextSession) => {
    if (!mountedRef.current) return;
    sessionRef.current = nextSession;
    setSessionState(nextSession);
  }, []);

  const setAdministrator = useCallback((nextAdministrator) => {
    if (!mountedRef.current) return;
    administratorRef.current = nextAdministrator;
    setAdministratorState(nextAdministrator);
  }, []);

  const cancelSessionRequest = useCallback(() => {
    const request = inFlightRef.current;
    inFlightRef.current = null;
    request?.controller.abort();
  }, []);

  const cancelLoginAttempt = useCallback(() => {
    const attempt = loginAttemptRef.current;
    loginAttemptRef.current = null;
    attempt?.controller.abort();
  }, []);

  const cancelAdminRequest = useCallback(() => {
    adminRequestGenerationRef.current += 1;
    const request = adminRequestRef.current;
    adminRequestRef.current = null;
    request?.controller.abort();
  }, []);

  const resetAdminAuthorization = useCallback(() => {
    adminAuthorizationGenerationRef.current += 1;
    cancelAdminRequest();
    setAdministrator(createInitialAdministrator());
  }, [cancelAdminRequest, setAdministrator]);

  const invalidateVerifiedSession = useCallback(() => {
    generationRef.current += 1;
    verifiedSessionRef.current = null;
    cancelSessionRequest();
    resetAdminAuthorization();
  }, [cancelSessionRequest, resetAdminAuthorization]);

  const beginGeneration = useCallback((token, loginOwner) => {
    if (!loginOwner) cancelLoginAttempt();
    generationRef.current += 1;
    currentTokenRef.current = token;
    verifiedSessionRef.current = null;
    cancelSessionRequest();
    resetAdminAuthorization();
    setSession(createInitialSession(token));
  }, [cancelLoginAttempt, cancelSessionRequest, resetAdminAuthorization, setSession]);

  const discardPendingLogin = useCallback(() => {
    const attempt = loginAttemptRef.current;
    cancelLoginAttempt();
    if (attempt?.provisional && currentTokenRef.current === attempt.token &&
        generationRef.current === attempt.generation) {
      if (getAuthToken() === attempt.token) {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        beginGeneration(null);
      } else {
        cancelSessionRequest();
      }
    }
  }, [beginGeneration, cancelLoginAttempt, cancelSessionRequest]);

  const endSession = useCallback(() => {
    cancelLoginAttempt();
    generationRef.current += 1;
    currentTokenRef.current = null;
    verifiedSessionRef.current = null;
    cancelSessionRequest();
    resetAdminAuthorization();
    setSession(createSession("unauthenticated"));
  }, [cancelLoginAttempt, cancelSessionRequest, resetAdminAuthorization, setSession]);

  const logout = useCallback(() => {
    endSession();
    dispatchingLogoutRef.current = true;
    try {
      logoutUser();
    } finally {
      dispatchingLogoutRef.current = false;
    }
  }, [endSession]);

  const verifySession = useCallback(() => {
    const token = getAuthToken();
    if (token !== currentTokenRef.current) beginGeneration(token || null);

    if (!token) {
      if (sessionRef.current.status !== "unauthenticated") {
        verifiedSessionRef.current = null;
        resetAdminAuthorization();
        setSession(createSession("unauthenticated"));
      }
      return Promise.resolve(sessionRef.current);
    }

    const activeRequest = inFlightRef.current;
    if (
      activeRequest &&
      activeRequest.token === token &&
      activeRequest.generation === generationRef.current
    ) {
      return activeRequest.promise;
    }

    const previousUser = sessionRef.current.status === "authenticated"
      ? sessionRef.current.user
      : null;
    setSession(
      previousUser
        ? createSession("authenticated", previousUser, null, true)
        : createSession("verifying"),
    );

    const controller = new AbortController();
    const request = {
      token,
      generation: generationRef.current,
      controller,
      promise: null,
      previousUser,
      loginAttempt: loginAttemptRef.current?.provisional ? loginAttemptRef.current : null,
    };
    inFlightRef.current = request;

    const isCurrentRequest = () => (
      mountedRef.current &&
      inFlightRef.current === request &&
      generationRef.current === request.generation &&
      currentTokenRef.current === request.token
    );

    const verifyReplacementToken = () => {
      if (!isCurrentRequest()) return Promise.resolve(sessionRef.current);
      const currentToken = getAuthToken();
      if (currentToken === request.token) return null;

      beginGeneration(currentToken || null);
      return currentToken
        ? Promise.resolve().then(() => (
          verifySessionRef.current?.() || sessionRef.current
        ))
        : Promise.resolve(sessionRef.current);
    };

    request.promise = (async () => {
      try {
        const identity = await getSessionIdentity(token, { signal: controller.signal });
        if (!isCurrentRequest()) return sessionRef.current;

        const replacementResult = verifyReplacementToken();
        if (replacementResult) return await replacementResult;

        const verifiedUser = createVerifiedUser(identity);
        if (previousUser && !isSameObjectId(previousUser.id, verifiedUser.id)) {
          invalidateVerifiedSession();
          setSession(createSession(
            "unavailable",
            null,
            createSafeError({ category: "identity-mismatch" }),
          ));
          return sessionRef.current;
        }

        if (previousUser && previousUser.role !== verifiedUser.role) {
          resetAdminAuthorization();
        }
        verifiedSessionRef.current = {
          token,
          generation: request.generation,
          userId: verifiedUser.id,
          role: verifiedUser.role,
        };
        setSession(createSession("authenticated", verifiedUser));
        return sessionRef.current;
      } catch (error) {
        if (!isCurrentRequest()) return sessionRef.current;

        const replacementResult = verifyReplacementToken();
        if (replacementResult) return await replacementResult;

        if (request.loginAttempt && request.loginAttempt === loginAttemptRef.current) {
          // The owning login will revoke its provisional token and report verification failure.
          return createSession("unavailable", null, createSafeError(error));
        }

        if (error?.category === "unauthorized") {
          logout();
          return sessionRef.current;
        }

        if (error?.category === "cancelled") {
          setSession(
            request.previousUser
              ? createSession("authenticated", request.previousUser)
              : createSession("unavailable"),
          );
          return sessionRef.current;
        }

        const safeError = createSafeError(error);
        if (error?.category === "forbidden") {
          invalidateVerifiedSession();
          setSession(createSession("unavailable", null, safeError));
        } else if (request.previousUser) {
          setSession(createSession("authenticated", request.previousUser, safeError));
        } else {
          setSession(createSession("unavailable", null, safeError));
        }
        return sessionRef.current;
      } finally {
        if (inFlightRef.current === request) inFlightRef.current = null;
      }
    })();

    return request.promise;
  }, [beginGeneration, invalidateVerifiedSession, logout, resetAdminAuthorization, setSession]);

  const login = useCallback(async (credentials) => {
    const cancelled = { status: "cancelled" };
    if (!mountedRef.current) return cancelled;
    discardPendingLogin();

    const attempt = {
      controller: new AbortController(),
      token: getAuthToken(),
      generation: generationRef.current,
      provisional: false,
    };
    loginAttemptRef.current = attempt;
    const ownsAttempt = () => (
      mountedRef.current &&
      loginAttemptRef.current === attempt &&
      generationRef.current === attempt.generation &&
      getAuthToken() === attempt.token
    );

    let established = false;
    try {
      let token;
      try {
        ({ token } = await exchangeLoginCredentials(credentials, { signal: attempt.controller.signal }));
      } catch (error) {
        if (!ownsAttempt() || error?.category === "cancelled") return cancelled;
        throw error;
      }
      if (!ownsAttempt()) return cancelled;

      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      attempt.token = token;
      attempt.provisional = true;
      beginGeneration(token, attempt);
      attempt.generation = generationRef.current;

      const verified = await verifySession();
      if (!ownsAttempt()) return cancelled;
      if (verified.status !== "authenticated") {
        logout();
        throw Object.assign(new Error("The new session could not be verified."), { category: "verification-error" });
      }

      attempt.provisional = false;
      established = true;
      return {
        status: "authenticated",
        isCurrent: () => ownsAttempt() && sessionRef.current.status === "authenticated",
      };
    } finally {
      if (!established && loginAttemptRef.current === attempt) {
        discardPendingLogin();
      }
    }
  }, [beginGeneration, discardPendingLogin, logout, verifySession]);

  const verifyAdmin = useCallback(() => {
    const token = getAuthToken();
    const verifiedSession = verifiedSessionRef.current;
    const currentSession = sessionRef.current;
    if (token !== currentTokenRef.current) {
      void verifySession();
      return Promise.resolve(administratorRef.current);
    }
    if (
      !mountedRef.current ||
      currentSession.status !== "authenticated" ||
      !verifiedSession ||
      verifiedSession.generation !== generationRef.current ||
      verifiedSession.token !== token ||
      !isSameObjectId(verifiedSession.userId, currentSession.user?.id)
    ) {
      return Promise.resolve(administratorRef.current);
    }

    const activeRequest = adminRequestRef.current;
    if (
      activeRequest &&
      activeRequest.token === token &&
      activeRequest.sessionGeneration === generationRef.current &&
      activeRequest.requestGeneration === adminRequestGenerationRef.current
    ) {
      return activeRequest.promise;
    }

    const authorizationGeneration = ++adminAuthorizationGenerationRef.current;
    const controller = new AbortController();
    const request = {
      token,
      userId: verifiedSession.userId,
      sessionGeneration: generationRef.current,
      authorizationGeneration,
      requestGeneration: ++adminRequestGenerationRef.current,
      controller,
      promise: null,
    };
    adminRequestRef.current = request;
    setAdministrator(Object.freeze({
      status: "pending",
      identity: null,
      error: null,
    }));

    const isCurrentRequest = () => {
      const currentVerifiedSession = verifiedSessionRef.current;
      const sessionNow = sessionRef.current;
      return (
        mountedRef.current &&
        adminRequestRef.current === request &&
        adminRequestGenerationRef.current === request.requestGeneration &&
        adminAuthorizationGenerationRef.current === request.authorizationGeneration &&
        generationRef.current === request.sessionGeneration &&
        currentTokenRef.current === request.token &&
        currentVerifiedSession?.token === request.token &&
        currentVerifiedSession?.generation === request.sessionGeneration &&
        isSameObjectId(currentVerifiedSession?.userId, request.userId) &&
        sessionNow.status === "authenticated" &&
        isSameObjectId(sessionNow.user?.id, request.userId)
      );
    };

    const verifyReplacementToken = () => {
      if (!isCurrentRequest()) return Promise.resolve(administratorRef.current);
      const currentToken = getAuthToken();
      if (currentToken === request.token) return null;

      beginGeneration(currentToken || null);
      return currentToken
        ? Promise.resolve().then(async () => {
          await verifySessionRef.current?.();
          return administratorRef.current;
        })
        : Promise.resolve(administratorRef.current);
    };

    request.promise = (async () => {
      try {
        const identity = await getAdminIdentity(token, { signal: controller.signal });
        if (!isCurrentRequest()) return administratorRef.current;

        const replacementResult = verifyReplacementToken();
        if (replacementResult) return await replacementResult;

        if (!isValidAdministratorIdentity(identity)) {
          setAdministrator(Object.freeze({
            status: "unavailable",
            identity: null,
            error: createSafeError({ category: "malformed-response" }, SAFE_ADMIN_ERROR_MESSAGES),
          }));
        } else if (!isSameObjectId(identity.userId, request.userId)) {
          setAdministrator(Object.freeze({
            status: "unavailable",
            identity: null,
            error: createSafeError({ category: "identity-mismatch" }, SAFE_ADMIN_ERROR_MESSAGES),
          }));
        } else {
          adminAuthorizationGenerationRef.current += 1;
          setAdministrator(Object.freeze({
            status: "verified",
            identity: Object.freeze({ userId: identity.userId, role: "admin" }),
            error: null,
          }));
        }
        return administratorRef.current;
      } catch (error) {
        if (!isCurrentRequest()) return administratorRef.current;

        const replacementResult = verifyReplacementToken();
        if (replacementResult) return await replacementResult;

        if (error?.category === "unauthorized") {
          logout();
        } else if (error?.category === "cancelled") {
          setAdministrator(createInitialAdministrator());
        } else if (error?.category === "forbidden") {
          setAdministrator(Object.freeze({
            status: "denied",
            identity: null,
            error: createSafeError(error, SAFE_ADMIN_ERROR_MESSAGES),
          }));
        } else {
          setAdministrator(Object.freeze({
            status: "unavailable",
            identity: null,
            error: createSafeError(error, SAFE_ADMIN_ERROR_MESSAGES),
          }));
        }
        return administratorRef.current;
      } finally {
        if (adminRequestRef.current === request) adminRequestRef.current = null;
      }
    })();

    return request.promise;
  }, [beginGeneration, logout, setAdministrator, verifySession]);

  const getCurrentSessionSnapshotMetadata = useCallback((snapshot) => {
    if (!mountedRef.current || !isSnapshotReference(snapshot)) return null;
    const metadata = sessionSnapshotsRef.current.get(snapshot);
    const verifiedSession = verifiedSessionRef.current;
    const currentSession = sessionRef.current;
    if (
      !metadata ||
      metadata.generation !== generationRef.current ||
      metadata.token !== currentTokenRef.current ||
      metadata.token !== getAuthToken() ||
      verifiedSession?.generation !== metadata.generation ||
      verifiedSession?.token !== metadata.token ||
      !isSameObjectId(verifiedSession?.userId, metadata.userId) ||
      currentSession.status !== "authenticated" ||
      !isSameObjectId(currentSession.user?.id, metadata.userId)
    ) {
      return null;
    }
    return metadata;
  }, []);

  const captureSessionSnapshot = useCallback(() => {
    if (!mountedRef.current) return null;
    const verifiedSession = verifiedSessionRef.current;
    const currentSession = sessionRef.current;
    const token = getAuthToken();
    if (
      currentSession.status !== "authenticated" ||
      !verifiedSession ||
      verifiedSession.generation !== generationRef.current ||
      verifiedSession.token !== currentTokenRef.current ||
      verifiedSession.token !== token ||
      !isSameObjectId(verifiedSession.userId, currentSession.user?.id)
    ) {
      return null;
    }

    const snapshot = Object.freeze({});
    sessionSnapshotsRef.current.set(snapshot, Object.freeze({
      generation: generationRef.current,
      token,
      userId: verifiedSession.userId,
    }));
    return snapshot;
  }, []);

  const invalidateSession = useCallback((expectedSession) => {
    if (!getCurrentSessionSnapshotMetadata(expectedSession)) return false;
    logout();
    return true;
  }, [getCurrentSessionSnapshotMetadata, logout]);

  const captureAdminAuthorizationSnapshot = useCallback((expectedSession) => {
    const sessionMetadata = getCurrentSessionSnapshotMetadata(expectedSession);
    const currentAdministrator = administratorRef.current;
    if (
      !sessionMetadata ||
      currentAdministrator.status !== "verified" ||
      !isSameObjectId(currentAdministrator.identity?.userId, sessionMetadata.userId)
    ) {
      return null;
    }

    const snapshot = Object.freeze({});
    administratorSnapshotsRef.current.set(snapshot, Object.freeze({
      sessionSnapshot: expectedSession,
      generation: sessionMetadata.generation,
      token: sessionMetadata.token,
      userId: sessionMetadata.userId,
      authorizationGeneration: adminAuthorizationGenerationRef.current,
    }));
    return snapshot;
  }, [getCurrentSessionSnapshotMetadata]);

  const getCurrentAdministratorSnapshotMetadata = useCallback((
    expectedSession,
    expectedAuthorization,
  ) => {
    const sessionMetadata = getCurrentSessionSnapshotMetadata(expectedSession);
    if (!sessionMetadata || !isSnapshotReference(expectedAuthorization)) return null;

    const authorizationMetadata = administratorSnapshotsRef.current.get(expectedAuthorization);
    const currentAdministrator = administratorRef.current;
    if (
      !authorizationMetadata ||
      authorizationMetadata.sessionSnapshot !== expectedSession ||
      authorizationMetadata.generation !== sessionMetadata.generation ||
      authorizationMetadata.token !== sessionMetadata.token ||
      authorizationMetadata.userId !== sessionMetadata.userId ||
      authorizationMetadata.authorizationGeneration !== adminAuthorizationGenerationRef.current ||
      currentAdministrator.status !== "verified" ||
      !isSameObjectId(currentAdministrator.identity?.userId, sessionMetadata.userId)
    ) {
      return null;
    }
    return authorizationMetadata;
  }, [getCurrentSessionSnapshotMetadata]);

  const invalidateAdminAuthorizationForRequest = useCallback((
    expectedSession,
    expectedAuthorization,
  ) => {
    if (!getCurrentAdministratorSnapshotMetadata(expectedSession, expectedAuthorization)) return false;

    adminAuthorizationGenerationRef.current += 1;
    cancelAdminRequest();
    setAdministrator(Object.freeze({
      status: "denied",
      identity: null,
      error: createSafeError(
        { category: "forbidden", status: 403 },
        SAFE_ADMIN_ERROR_MESSAGES,
      ),
    }));
    return true;
  }, [cancelAdminRequest, getCurrentAdministratorSnapshotMetadata, setAdministrator]);

  const captureAuthenticatedRequest = useCallback((requestOptions = {}) => {
    if (
      !requestOptions ||
      typeof requestOptions !== "object" ||
      Array.isArray(requestOptions) ||
      (requestOptions.administrator !== undefined &&
        typeof requestOptions.administrator !== "boolean")
    ) {
      return null;
    }

    const requiresAdministrator = requestOptions.administrator === true;
    const sessionSnapshot = captureSessionSnapshot();
    if (!sessionSnapshot) return null;
    const sessionMetadata = sessionSnapshotsRef.current.get(sessionSnapshot);
    if (!sessionMetadata || typeof sessionMetadata.token !== "string") return null;

    const administratorSnapshot = requiresAdministrator
      ? captureAdminAuthorizationSnapshot(sessionSnapshot)
      : null;
    if (requiresAdministrator && !administratorSnapshot) return null;

    const isCurrent = () => (
      Boolean(
        getCurrentSessionSnapshotMetadata(sessionSnapshot) &&
        (!requiresAdministrator ||
          getCurrentAdministratorSnapshotMetadata(sessionSnapshot, administratorSnapshot))
      )
    );

    const requestFetch = async (url, options = {}) => {
      const requestUrl = parseAuthenticatedRequestUrl(url, requiresAdministrator);
      const fetchOptions = prepareAuthenticatedRequestOptions(options, sessionMetadata.token);
      const signal = fetchOptions.signal;
      if (signal?.aborted) throw createAuthenticatedRequestError("cancelled");
      if (!isCurrent()) throw createAuthenticatedRequestError("stale-session");

      let response;
      try {
        response = await fetch(requestUrl.href, fetchOptions);
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          throw createAuthenticatedRequestError("cancelled");
        }
        if (!isCurrent()) throw createAuthenticatedRequestError("stale-session");
        throw createAuthenticatedRequestError("network-error");
      }

      if (signal?.aborted) throw createAuthenticatedRequestError("cancelled");
      if (!isCurrent()) throw createAuthenticatedRequestError("stale-session");

      if (response.status === 401) {
        if (invalidateSession(sessionSnapshot)) {
          throw createAuthenticatedRequestError("unauthorized", 401);
        }
        throw createAuthenticatedRequestError("stale-session");
      }

      if (requiresAdministrator && response.status === 403) {
        if (invalidateAdminAuthorizationForRequest(
          sessionSnapshot,
          administratorSnapshot,
        )) {
          throw createAuthenticatedRequestError("forbidden", 403);
        }
        throw createAuthenticatedRequestError("stale-session");
      }

      return response;
    };

    const capability = Object.freeze({
      isCurrent,
      fetch: requestFetch,
    });
    return capability.isCurrent() ? capability : null;
  }, [
    captureAdminAuthorizationSnapshot,
    captureSessionSnapshot,
    getCurrentAdministratorSnapshotMetadata,
    getCurrentSessionSnapshotMetadata,
    invalidateAdminAuthorizationForRequest,
    invalidateSession,
  ]);

  const invalidateAdminAuthorization = useCallback(() => {
    resetAdminAuthorization();
  }, [resetAdminAuthorization]);

  const completeLogin = useCallback(() => {
    const token = getAuthToken();
    beginGeneration(token || null);
    return token ? verifySession() : Promise.resolve(sessionRef.current);
  }, [beginGeneration, verifySession]);

  useEffect(() => {
    mountedRef.current = true;
    verifySessionRef.current = verifySession;
    const handleLogoutEvent = () => {
      if (!dispatchingLogoutRef.current) endSession();
    };
    const handleStorageEvent = (event) => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== TOKEN_STORAGE_KEY && event.key !== null)
      ) {
        return;
      }

      const currentToken = getAuthToken();
      if (currentToken === currentTokenRef.current) {
        if (!loginAttemptRef.current || (event.key !== null && event.oldValue === event.newValue)) return;
        if (!loginAttemptRef.current.provisional) {
          cancelLoginAttempt();
          return;
        }
      }

      if (!currentToken) {
        endSession();
        return;
      }

      beginGeneration(currentToken);
      void verifySession();
    };

    window.addEventListener("prepx:logout", handleLogoutEvent);
    window.addEventListener("storage", handleStorageEvent);
    if (getAuthToken()) void verifySession();

    return () => {
      mountedRef.current = false;
      if (verifySessionRef.current === verifySession) verifySessionRef.current = null;
      window.removeEventListener("prepx:logout", handleLogoutEvent);
      window.removeEventListener("storage", handleStorageEvent);
      discardPendingLogin();
      cancelSessionRequest();
      cancelAdminRequest();
    };
  }, [beginGeneration, cancelAdminRequest, cancelLoginAttempt, cancelSessionRequest, discardPendingLogin, endSession, verifySession]);

  const value = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => Object.freeze({
      session,
      administrator,
      verifySession,
      completeLogin,
      logout,
      verifyAdmin,
      invalidateAdminAuthorization,
      captureSessionSnapshot,
      invalidateSession,
      captureAdminAuthorizationSnapshot,
      invalidateAdminAuthorizationForRequest,
      captureAuthenticatedRequest,
      login,
    }),
    [
      session,
      administrator,
      verifySession,
      completeLogin,
      logout,
      verifyAdmin,
      invalidateAdminAuthorization,
      captureSessionSnapshot,
      invalidateSession,
      captureAdminAuthorizationSnapshot,
      invalidateAdminAuthorizationForRequest,
      captureAuthenticatedRequest,
      login,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// The provider and its consumer hook intentionally share this context module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const auth = useContext(AuthContext);
  if (auth === null) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }
  return auth;
}
