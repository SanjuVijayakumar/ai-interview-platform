import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAuthToken } from "../services/authService.js";

const INTERVIEWS_URL = "http://localhost:5000/api/interviews";

const statDefinitions = [
  {
    label: "Total interviews",
    icon: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h3m-3 3h7" /></>,
    tone: "bg-indigo-50 text-indigo-700",
  },
  {
    label: "Completed interviews",
    icon: <><path d="M8 12.5 10.5 15 16 9" /><circle cx="12" cy="12" r="9" /></>,
    tone: "bg-emerald-50 text-emerald-700",
  },
  {
    label: "Pending interviews",
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    tone: "bg-amber-50 text-amber-700",
  },
  {
    label: "Average score",
    icon: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    tone: "bg-sky-50 text-sky-700",
  },
];

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function statusStyle(status) {
  if (status === "completed") return "bg-emerald-50 text-emerald-700";
  if (status === "in-progress") return "bg-indigo-50 text-indigo-700";
  return "bg-amber-50 text-amber-700";
}

function formatStatus(status) {
  if (!status) return "Status unavailable";
  return status.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function DashboardPage({ user }) {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const firstName = user?.name?.trim().split(/\s+/)[0];

  useEffect(() => {
    let cancelled = false;

    async function loadInterviews() {
      const token = getAuthToken();
      if (!token) {
        setError("Your session is missing. Please sign in again to view your dashboard.");
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(INTERVIEWS_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.message || "We couldn't load your interviews. Please try again.");
        }
        if (!Array.isArray(data.interviews)) {
          throw new Error("The interviews response was not in the expected format.");
        }

        if (!cancelled) {
          setInterviews(data.interviews);
          setError("");
        }
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || "We couldn't load your interviews. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInterviews();
    return () => { cancelled = true; };
  }, []);

  const completedCount = interviews.filter((interview) => interview.status === "completed").length;
  const pendingCount = interviews.filter((interview) => interview.status === "scheduled" || interview.status === "in-progress").length;
  const statValues = [
    { value: loading ? "…" : error ? "—" : interviews.length, note: error ? "Unavailable" : loading ? "Loading your interviews" : "From your interview history" },
    { value: loading ? "…" : error ? "—" : completedCount, note: error ? "Unavailable" : "Marked completed" },
    { value: loading ? "…" : error ? "—" : pendingCount, note: error ? "Unavailable" : "Scheduled or in progress" },
    { value: "—", note: "Score data isn't available from a user-scoped endpoint" },
  ];
  const recentInterviews = [...interviews]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5);

  return (
    <div className="space-y-8 sm:space-y-10">
      <section className="flex flex-col justify-between gap-6 rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:p-8">
        <div className="max-w-2xl">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">YOUR PREPX OVERVIEW</p>
          <h2 className="font-[Manrope,sans-serif] text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {firstName ? `Welcome back, ${firstName}` : "Welcome to PrepX"}
          </h2>
          <p className="mb-0 mt-2 max-w-xl text-sm leading-6 text-slate-500 sm:text-base">A little practice goes a long way. Build your confidence one interview at a time.</p>
        </div>
        <Link to="/interviews" className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Start new interview
        </Link>
      </section>

      <section aria-labelledby="stats-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="stats-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold text-slate-900">Your progress</h2>
            <p className="mb-0 text-sm text-slate-500">A snapshot of your interview practice.</p>
          </div>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500">{loading ? "Updating from your account" : "Based on your interview history"}</span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {statDefinitions.map(({ label, icon, tone }, index) => (
            <article key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
              <div className="mb-5 flex items-center justify-between gap-3">
                <p className="mb-0 text-sm font-medium text-slate-500">{label}</p>
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone}`}>
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
                </span>
              </div>
              <p className="mb-1 font-[Manrope,sans-serif] text-3xl font-bold tracking-tight text-slate-900">{statValues[index].value}</p>
              <p className="mb-0 text-xs text-slate-400">{statValues[index].note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-labelledby="recent-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-5 sm:px-6">
          <div>
            <h2 id="recent-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold text-slate-900">Recent interviews</h2>
            <p className="mb-0 text-sm text-slate-500">Your latest practice sessions.</p>
          </div>
          <Link to="/interviews" className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            View all
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </Link>
        </div>

        {loading ? (
          <div className="flex min-h-56 items-center justify-center gap-3 px-5 text-sm text-slate-500" role="status">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-100 border-t-indigo-600" />
            Loading your interviews…
          </div>
        ) : error ? (
          <div className="px-5 py-10 text-center sm:px-8" role="alert">
            <p className="mx-auto mb-4 max-w-xl rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
            <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Reload dashboard</button>
          </div>
        ) : recentInterviews.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-10 text-center sm:px-8 sm:py-14">
            <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
              <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h.01" /></svg>
            </span>
            <h3 className="mb-2 font-[Manrope,sans-serif] text-base font-bold text-slate-900">Your interview history starts here</h3>
            <p className="mb-5 max-w-md text-sm leading-6 text-slate-500">Create your first practice interview and your sessions will appear here.</p>
            <Link to="/interviews" className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">Create your first interview<svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg></Link>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentInterviews.map((interview) => (
              <article key={interview._id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <h3 className="mb-1 truncate text-sm font-semibold text-slate-900">{interview.title || "Untitled interview"}</h3>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <span>{interview.category || "Category unavailable"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{interview.difficulty || "Difficulty unavailable"}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={interview.createdAt || undefined}>{formatDate(interview.createdAt)}</time>
                  </div>
                </div>
                <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${statusStyle(interview.status)}`}>{formatStatus(interview.status)}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col justify-between gap-5 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-5 sm:flex-row sm:items-center sm:p-6" aria-label="Quick action">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm"><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.36 6.36-2.12-2.12M7.76 7.76 5.64 5.64m12.72 0-2.12 2.12M7.76 16.24l-2.12 2.12" /><circle cx="12" cy="12" r="4" /></svg></span>
          <div><h2 className="mb-1 font-[Manrope,sans-serif] text-base font-bold text-slate-900">Ready for your next practice?</h2><p className="mb-0 text-sm text-slate-600">Choose a role and difficulty, then get started.</p></div>
        </div>
        <Link to="/interviews" className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">Start an interview<svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></Link>
      </section>
    </div>
  );
}

export default DashboardPage;
