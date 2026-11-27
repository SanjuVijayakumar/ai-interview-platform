import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";

function subscribeToSessionEvents(onChange) {
  window.addEventListener("storage", onChange);
  window.addEventListener("prepx:logout", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("prepx:logout", onChange);
  };
}

function isCurrentCapability(capability) {
  return typeof capability?.fetch === "function" &&
    typeof capability.isCurrent === "function" &&
    capability.isCurrent() === true;
}

function VerificationLoading() {
  return (
    <div className="flex min-h-64 items-center justify-center gap-3 theme-text-secondary" role="status" aria-live="polite">
      <span className="h-5 w-5 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" aria-hidden="true" />
      Verifying your session…
    </div>
  );
}

function VerificationUnavailable({ onRetry, onSignOut, retrying }) {
  return (
    <section className="mx-auto max-w-md rounded-2xl border theme-border theme-card-surface p-6 theme-text-primary">
      <h1 className="text-lg font-semibold">Session verification unavailable</h1>
      <p className="mt-2 theme-text-secondary" role="alert">We could not verify your session. Try again or sign out.</p>
      <div className="mt-4 flex gap-3">
        <button className="theme-primary-button rounded-xl px-4 py-2" type="button" onClick={onRetry} disabled={retrying}>
          Retry
        </button>
        <button className="rounded-xl border theme-border px-4 py-2" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
}

/** Under AuthProvider and a router, children({ capability }) renders protected content. */
export default function ProtectedSessionBoundary({ children }) {
  const { session, captureAuthenticatedRequest, verifySession, logout } = useAuth();
  const [lifecycle, setLifecycle] = useState(null);
  const capability = lifecycle?.capability;
  const readCurrentness = useCallback(() => isCurrentCapability(capability), [capability]);
  const current = useSyncExternalStore(subscribeToSessionEvents, readCurrentness, () => false);
  const authenticated = session.status === "authenticated";

  useEffect(() => {
    if (!authenticated || current) return;

    // Capture after the provider's effects and ignore work from an abandoned render.
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const captured = captureAuthenticatedRequest();
      const nextCapability = isCurrentCapability(captured) ? captured : null;
      setLifecycle((previous) => ({
        key: (previous?.key ?? 0) + 1,
        capability: nextCapability,
      }));
    });
    return () => { active = false; };
  }, [authenticated, captureAuthenticatedRequest, current, session]);

  if (session.status === "unauthenticated") return <Navigate to="/login" replace />;
  if (session.status === "verifying" || (authenticated && !lifecycle)) {
    return <VerificationLoading />;
  }
  if (!authenticated || !current) {
    return <VerificationUnavailable onRetry={verifySession} onSignOut={logout} retrying={session.isRevalidating} />;
  }
  return <Fragment key={lifecycle.key}>{children({ capability })}</Fragment>;
}
