import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useOutletContext } from "react-router-dom";
import ProtectedAdminBoundary from "./components/auth/ProtectedAdminBoundary.jsx";
import ProtectedSessionBoundary from "./components/auth/ProtectedSessionBoundary.jsx";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import AdminLayout from "./layouts/AdminLayout.jsx";
import { AuthenticatedDashboardLayout } from "./layouts/DashboardLayout.jsx";
import AdminDashboardPlaceholder from "./pages/AdminDashboardPlaceholder.jsx";
import AdminPlaceholder from "./pages/AdminPlaceholder.jsx";
import { CapabilityBoundDashboardPage } from "./pages/DashboardPage.jsx";
import { CapabilityBoundInterviewsPage } from "./pages/InterviewsPage.jsx";
import { CapabilityBoundInterviewDetailsPage } from "./pages/InterviewDetailsPage.jsx";
import { CapabilityBoundMockSessionPage } from "./pages/MockSessionPage.jsx";
import { ProviderBoundLoginPage } from "./pages/LoginPage.jsx";
import { CapabilityBoundProfilePage } from "./pages/ProfilePage.jsx";
import { CapabilityBoundResultsPage } from "./pages/ResultsPage.jsx";
import { CapabilityBoundEvaluationResultPage } from "./pages/EvaluationResultPage.jsx";
import "./App.css";

const adminNavigation = [
  {
    label: "Overview",
    pages: [
      { path: "dashboard", title: "Dashboard", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" },
    ],
  },
  {
    label: "Management",
    pages: [
      { path: "users", title: "Users", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4m-3-12a4 4 0 0 1 0 8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" },
      { path: "interviews", title: "Interviews", icon: "M16 3v4M8 3v4M3 10h18M3 5h18v16H3zm5 10h8m-8 3h4" },
      { path: "questions", title: "Questions", icon: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM9 9a3 3 0 1 1 4 2.8c-1 .4-1 1.2-1 2.2m0 3h.01" },
      { path: "evaluations", title: "Evaluations", icon: "M8 5H5v16h14V5h-3M8 3h8v4H8zm1 11 2 2 4-4" },
    ],
  },
  {
    label: "Monitoring",
    pages: [
      { path: "ai-monitoring", title: "AI Monitoring", icon: "M3 4h18v13H3zm9 13v4m-4 0h8M5 11h3l2-3 3 6 2-3h4" },
      { path: "activity-logs", title: "Activity Logs", icon: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 5h6m-6 4h6m-6 4h4" },
    ],
  },
  {
    label: "Account",
    pages: [
      { path: "profile", title: "Profile", icon: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 21v-1a7 7 0 0 1 14 0v1" },
    ],
  },
];

function LandingDecision({ capability }) {
  const { session, administrator, verifyAdmin, captureAuthenticatedRequest, logout } = useAuth();
  const navigate = useNavigate();
  const needsAdmin = session.user.role === "admin";
  const status = administrator.status;
  const [attempted, setAttempted] = useState(status !== "not-requested");
  const personal = !needsAdmin || status === "denied";

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active || !capability.isCurrent()) return;
      if (personal) {
        navigate("/dashboard", { replace: true });
      } else if (status === "verified") {
        if (captureAuthenticatedRequest({ administrator: true })) {
          navigate("/admin/dashboard", { replace: true });
        }
      } else if (status === "not-requested" && !attempted) {
        setAttempted(true);
        void verifyAdmin();
      }
    });
    return () => { active = false; };
  }, [attempted, capability, captureAuthenticatedRequest, navigate, personal, status, verifyAdmin]);

  if (needsAdmin && (status === "unavailable" || (status === "not-requested" && attempted))) {
    return (
      <section className="mx-auto max-w-md p-6 theme-text-primary">
        <h1 className="text-lg font-semibold">Administrator verification unavailable</h1>
        <p className="mt-2 theme-text-secondary" role="alert">We could not verify administrator access.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="theme-primary-button rounded-xl px-4 py-2" onClick={() => {
            if (capability.isCurrent()) void verifyAdmin();
          }}>Retry</button>
          <button type="button" className="rounded-xl border theme-border px-4 py-2" onClick={logout}>Sign out</button>
          <button type="button" className="rounded-xl border theme-border px-4 py-2" onClick={() => {
            if (capability.isCurrent()) navigate("/dashboard", { replace: true });
          }}>Continue to personal dashboard</button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex min-h-64 items-center justify-center gap-3 theme-text-secondary" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" aria-hidden="true" />
      {needsAdmin && (status === "not-requested" || status === "pending")
        ? "Verifying administrator access…"
        : "Opening your dashboard…"}
    </div>
  );
}

function LandingRoute() {
  return (
    <ProtectedSessionBoundary>
      {({ capability }) => <LandingDecision capability={capability} />}
    </ProtectedSessionBoundary>
  );
}

function LoginRoute({ healthMessage }) {
  const { session, verifySession, logout } = useAuth();
  const [submission, setSubmission] = useState(null);
  const onSubmissionChange = useCallback((attempt, pending) => {
    setSubmission((current) => pending ? attempt : current === attempt ? null : current);
  }, []);

  if (submission || session.status === "unauthenticated") {
    return <ProviderBoundLoginPage
      healthMessage={healthMessage}
      onSubmissionChange={onSubmissionChange}
      onVerifiedLogin={(attempt) => onSubmissionChange(attempt, false)}
    />;
  }
  if (session.status === "authenticated") return <LandingRoute />;
  if (session.status === "verifying") {
    return (
      <div className="flex min-h-64 items-center justify-center gap-3 theme-text-secondary" role="status" aria-live="polite">
        <span className="h-5 w-5 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" aria-hidden="true" />
        Verifying your session…
      </div>
    );
  }
  return (
    <section className="mx-auto max-w-md rounded-2xl border theme-border theme-card-surface p-6 theme-text-primary">
      <h1 className="text-lg font-semibold">Session verification unavailable</h1>
      <p className="mt-2 theme-text-secondary" role="alert">We could not verify your session. Try again or sign out.</p>
      <div className="mt-4 flex gap-3">
        <button className="theme-primary-button rounded-xl px-4 py-2" type="button" onClick={verifySession}>Retry</button>
        <button className="rounded-xl border theme-border px-4 py-2" type="button" onClick={logout}>Sign out</button>
      </div>
    </section>
  );
}

function ProtectedPage({ component: Page, healthMessage }) {
  const { capability, user } = useOutletContext();
  return <Page capability={capability} user={user} healthMessage={healthMessage} />;
}

function AppRoutes({ healthMessage }) {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/login" element={<LoginRoute healthMessage={healthMessage} />} />
      <Route path="/admin" element={
        <ProtectedAdminBoundary>
          {({ capability }) => <AdminLayout capability={capability} groups={adminNavigation} />}
        </ProtectedAdminBoundary>
      }>
        <Route index element={<Navigate to="dashboard" replace />} />
        {adminNavigation.flatMap(({ pages }) => pages).map(({ path, title }) => (
          <Route key={path} path={path} element={path === "dashboard"
            ? <AdminDashboardPlaceholder />
            : <AdminPlaceholder>{title} functionality is pending.</AdminPlaceholder>}
          />
        ))}
        <Route path="*" element={<AdminPlaceholder title="Administrator page unavailable">
          Choose a page from the administrator navigation.
        </AdminPlaceholder>} />
      </Route>
      <Route element={
        <ProtectedSessionBoundary>
          {({ capability }) => <AuthenticatedDashboardLayout capability={capability} />}
        </ProtectedSessionBoundary>
      }>
        <Route path="/dashboard" element={<ProtectedPage component={CapabilityBoundDashboardPage} />} />
        <Route path="/interviews" element={<ProtectedPage component={CapabilityBoundInterviewsPage} />} />
        <Route path="/interviews/:interviewId" element={<ProtectedPage component={CapabilityBoundInterviewDetailsPage} />} />
        <Route path="/results" element={<ProtectedPage component={CapabilityBoundResultsPage} />} />
        <Route path="/results/:resultId" element={<ProtectedPage component={CapabilityBoundEvaluationResultPage} />} />
        <Route path="/mock-session/:sessionId" element={<ProtectedPage component={CapabilityBoundMockSessionPage} />} />
        <Route path="/profile" element={<ProtectedPage component={CapabilityBoundProfilePage} healthMessage={healthMessage} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

function App() {
  const [healthMessage, setHealthMessage] = useState("Checking backend status...");

  useEffect(() => {
    fetch("http://localhost:5000/api/health")
      .then((response) => response.json())
      .then((data) => setHealthMessage(data.message || "Backend is available"))
      .catch((error) => {
        console.error("Backend health check failed:", error);
        setHealthMessage("Could not reach backend");
      });
  }, []);

  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes healthMessage={healthMessage} />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
