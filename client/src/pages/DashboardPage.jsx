import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import InterviewPracticeStatusBadge from "../components/InterviewPracticeStatusBadge.jsx";
import { logoutUser } from "../services/authService.js";
import { getDashboardStats } from "../services/dashboardService.js";
import { getInterviews } from "../services/interviewService.js";

const statDefinitions = [
  {
    label: "Total interviews",
    icon: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h3m-3 3h7" /></>,
    tone: "theme-stat-icon theme-stat-icon-green",
    cardTone: "theme-stat-green",
  },
  {
    label: "Completed interviews",
    icon: <><path d="M8 12.5 10.5 15 16 9" /><circle cx="12" cy="12" r="9" /></>,
    tone: "theme-stat-icon theme-stat-icon-teal",
    cardTone: "theme-stat-teal",
  },
  {
    label: "Pending interviews",
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    tone: "theme-stat-icon theme-stat-icon-gold",
    cardTone: "theme-stat-gold",
  },
  {
    label: "Average score",
    icon: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    tone: "theme-stat-icon theme-stat-icon-blue",
    cardTone: "theme-stat-blue",
  },
];

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatAverageScore(score) {
  if (score === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(score);
}

function DashboardPage({ user }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState("");
  const [statsRetry, setStatsRetry] = useState(0);
  const [interviews, setInterviews] = useState([]);
  const [interviewsLoading, setInterviewsLoading] = useState(true);
  const [interviewsError, setInterviewsError] = useState("");
  const [interviewsRetry, setInterviewsRetry] = useState(0);
  const authenticationRedirected = useRef(false);
  const firstName = user?.name?.trim().split(/\s+/)[0];

  useEffect(() => {
    let active = true;
    async function loadStats() {
      setStatsLoading(true);
      setStatsError("");
      try {
        const result = await getDashboardStats();
        if (active) setStats(result);
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 401) {
          if (!authenticationRedirected.current) {
            authenticationRedirected.current = true;
            logoutUser();
            navigate("/login", { replace: true });
          }
          return;
        }
        setStatsError(requestError.message || "We couldn't load your dashboard statistics. Please try again.");
      } finally {
        if (active) setStatsLoading(false);
      }
    }

    loadStats();
    return () => { active = false; };
  }, [navigate, statsRetry]);

  useEffect(() => {
    let active = true;
    async function loadInterviewHistory() {
      setInterviewsLoading(true);
      setInterviewsError("");
      try {
        const items = await getInterviews();
        if (active) setInterviews(items);
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 401) {
          if (!authenticationRedirected.current) {
            authenticationRedirected.current = true;
            logoutUser();
            navigate("/login", { replace: true });
          }
          return;
        }
        setInterviewsError(requestError.message || "We couldn't load your interviews. Please try again.");
      } finally {
        if (active) setInterviewsLoading(false);
      }
    }

    loadInterviewHistory();
    return () => { active = false; };
  }, [interviewsRetry, navigate]);

  const statsUnavailable = Boolean(statsError) || !stats;
  const statValues = [
    { value: statsLoading ? "…" : statsUnavailable ? "—" : stats.totalInterviews, note: statsLoading ? "Loading your statistics" : statsUnavailable ? "Unavailable" : "From your interview history" },
    { value: statsLoading ? "…" : statsUnavailable ? "—" : stats.completedInterviews, note: statsLoading ? "Loading your statistics" : statsUnavailable ? "Unavailable" : "Completed mock-session activity" },
    { value: statsLoading ? "…" : statsUnavailable ? "—" : stats.pendingInterviews, note: statsLoading ? "Loading your statistics" : statsUnavailable ? "Unavailable" : "Without a completed mock session" },
    { value: statsLoading ? "…" : statsUnavailable ? "—" : formatAverageScore(stats.averageScore), note: statsLoading ? "Loading your statistics" : statsUnavailable ? "Unavailable" : "Across completed AI evaluations" },
  ];
  const recentInterviews = [...interviews]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5);

  return (
    <div className="space-y-8 sm:space-y-10">
      <section className="theme-welcome-card flex flex-col justify-between gap-6 rounded-2xl border p-6 shadow-sm sm:flex-row sm:items-center sm:p-8">
        <div className="max-w-2xl">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] theme-text-accent">YOUR PREPX OVERVIEW</p>
          <h2 className="theme-welcome-heading font-[Manrope,sans-serif] text-2xl font-bold tracking-tight sm:text-3xl">
            {firstName ? `Welcome back, ${firstName}` : "Welcome to PrepX"}
          </h2>
          <p className="mb-0 mt-2 max-w-xl text-sm leading-6 theme-text-secondary sm:text-base">A little practice goes a long way. Build your confidence one interview at a time.</p>
        </div>
        <Link to="/interviews" className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-semibold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Start new interview
        </Link>
      </section>

      <section aria-labelledby="stats-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="stats-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Your progress</h2>
            <p className="mb-0 text-sm theme-text-secondary">A snapshot of your interview practice.</p>
          </div>
          <span className="rounded-full border theme-border theme-card-surface px-3 py-1 text-xs font-medium theme-text-secondary">{statsLoading ? "Updating from your account" : "Based on your interview history"}</span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {statDefinitions.map(({ label, icon, tone, cardTone }, index) => (
            <article key={label} className={`theme-stat-card ${cardTone} rounded-2xl border p-5 shadow-sm transition-shadow hover:shadow-md`}>
              <div className="mb-5 flex items-center justify-between gap-3">
                <p className="mb-0 text-sm font-medium theme-text-secondary">{label}</p>
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone}`}>
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
                </span>
              </div>
              <p className="mb-1 font-[Manrope,sans-serif] text-3xl font-bold tracking-tight theme-text-primary">{statValues[index].value}</p>
              <p className="mb-0 text-xs theme-text-muted">{statValues[index].note}</p>
            </article>
          ))}
        </div>
        {statsError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border theme-border-error theme-error-surface px-4 py-3" role="alert">
            <p className="mb-0 text-sm theme-text-error">{statsError}</p>
            <button type="button" onClick={() => setStatsRetry((count) => count + 1)} className="rounded-lg border theme-border theme-card-surface px-3 py-2 text-sm font-semibold theme-text-primary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Retry statistics</button>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border theme-border theme-card-surface shadow-sm" aria-labelledby="recent-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b theme-border-subtle px-5 py-5 sm:px-6">
          <div>
            <h2 id="recent-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Recent interviews</h2>
            <p className="mb-0 text-sm theme-text-secondary">Your latest practice sessions.</p>
          </div>
          <Link to="/interviews" className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold theme-text-accent transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">
            View all
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </Link>
        </div>

        {interviewsLoading ? (
          <div className="flex min-h-56 items-center justify-center gap-3 px-5 text-sm theme-text-secondary" role="status">
            <span className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" />
            Loading your interviews…
          </div>
        ) : interviewsError ? (
          <div className="px-5 py-10 text-center sm:px-8" role="alert">
            <p className="mx-auto mb-4 max-w-xl rounded-xl border theme-border-error theme-error-surface px-4 py-3 text-sm theme-text-error">{interviewsError}</p>
            <button type="button" onClick={() => setInterviewsRetry((count) => count + 1)} className="rounded-lg border theme-border theme-card-surface px-4 py-2 text-sm font-semibold theme-text-primary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Reload interviews</button>
          </div>
        ) : recentInterviews.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-10 text-center sm:px-8 sm:py-14">
            <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent">
              <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h.01" /></svg>
            </span>
            <h3 className="mb-2 font-[Manrope,sans-serif] text-base font-bold theme-text-primary">Your interview history starts here</h3>
            <p className="mb-5 max-w-md text-sm leading-6 theme-text-secondary">Create your first practice interview and your sessions will appear here.</p>
            <Link to="/interviews" className="inline-flex items-center gap-2 rounded-lg border theme-border-highlight theme-card-surface px-4 py-2.5 text-sm font-semibold theme-text-accent transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">Create your first interview<svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg></Link>
          </div>
        ) : (
          <div className="divide-y theme-dividers">
            {recentInterviews.map((interview) => (
              <article key={interview._id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <h3 className="mb-1 truncate text-sm font-semibold theme-text-primary">{interview.title || "Untitled interview"}</h3>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs theme-text-secondary">
                    <span>{interview.category || "Category unavailable"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{interview.difficulty || "Difficulty unavailable"}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={interview.createdAt || undefined}>{formatDate(interview.createdAt)}</time>
                  </div>
                </div>
                <InterviewPracticeStatusBadge practiceStatus={interview.practiceStatus} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col justify-between gap-5 rounded-2xl border theme-border-highlight theme-accent-soft-surface p-5 sm:flex-row sm:items-center sm:p-6" aria-label="Quick action">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl theme-card-surface theme-text-accent shadow-sm"><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.36 6.36-2.12-2.12M7.76 7.76 5.64 5.64m12.72 0-2.12 2.12M7.76 16.24l-2.12 2.12" /><circle cx="12" cy="12" r="4" /></svg></span>
          <div><h2 className="mb-1 font-[Manrope,sans-serif] text-base font-bold theme-text-primary">Ready for your next practice?</h2><p className="mb-0 text-sm theme-text-secondary">Choose a role and difficulty, then get started.</p></div>
        </div>
        <Link to="/interviews" className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border theme-border-highlight theme-card-surface px-4 py-2.5 text-sm font-semibold theme-text-accent transition theme-hover-border theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">Start an interview<svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></Link>
      </section>
    </div>
  );
}

export default DashboardPage;
