import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";
import ProtectedSessionBoundary from "./ProtectedSessionBoundary.jsx";

function AdministratorAuthorization({ children }) {
  const { administrator, verifyAdmin, captureAuthenticatedRequest, logout } = useAuth();
  const [authorization, setAuthorization] = useState(null);
  const status = administrator.status;
  const [attempted, setAttempted] = useState(status !== "not-requested");

  useEffect(() => {
    if (status !== "verified" && (status !== "not-requested" || attempted)) return;

    let active = true;
    // Defer until provider effects have settled, including StrictMode effect replay.
    queueMicrotask(() => {
      if (!active) return;
      if (status === "not-requested") {
        // An invalidated or cancelled attempt requires an explicit retry.
        setAttempted(true);
        void verifyAdmin();
      } else if (status === "verified") {
        setAuthorization({
          administrator,
          capability: captureAuthenticatedRequest({ administrator: true }),
        });
      }
    });
    return () => { active = false; };
  }, [administrator, status, attempted, captureAuthenticatedRequest, verifyAdmin]);

  const captured = authorization?.administrator === administrator;
  if (status === "verified" && captured && authorization.capability?.isCurrent()) {
    return children({ capability: authorization.capability });
  }

  if (status === "denied") {
    return (
      <section className="mx-auto max-w-md p-6 theme-text-primary">
        <h1 className="text-lg font-semibold">Access Denied</h1>
        <p className="mt-2 theme-text-secondary">Administrator access is required.</p>
        <Link className="mt-4 inline-block underline" to="/dashboard">Back to your dashboard</Link>
      </section>
    );
  }

  if (
    status === "unavailable" ||
    (status === "not-requested" && attempted) ||
    (status === "verified" && captured)
  ) {
    return (
      <section className="mx-auto max-w-md p-6 theme-text-primary">
        <h1 className="text-lg font-semibold">Administrator verification unavailable</h1>
        <p className="mt-2 theme-text-secondary" role="alert">We could not verify administrator access. Try again or sign out.</p>
        <div className="mt-4 flex gap-3">
          <button className="theme-primary-button rounded-xl px-4 py-2" type="button" onClick={verifyAdmin}>Retry</button>
          <button className="rounded-xl border theme-border px-4 py-2" type="button" onClick={logout}>Sign out</button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex min-h-64 items-center justify-center gap-3 theme-text-secondary" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" aria-hidden="true" />
      Verifying administrator access…
    </div>
  );
}

/** Under AuthProvider and a router, children({ capability }) receives an administrator-scoped capability. */
export default function ProtectedAdminBoundary({ children }) {
  return (
    <ProtectedSessionBoundary>
      {() => <AdministratorAuthorization>{children}</AdministratorAuthorization>}
    </ProtectedSessionBoundary>
  );
}
