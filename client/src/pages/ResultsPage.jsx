import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getInterviewResults } from "../services/resultService.js";
import { logoutUser } from "../services/authService.js";

const statusLabels = {
  "not-requested": "Evaluation not started",
  pending: "Evaluation in progress",
  completed: "Evaluation ready",
  failed: "Evaluation needs a retry",
};

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function ResultsPage() {
  const navigate = useNavigate();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadResults() {
      setLoading(true);
      setError("");
      try {
        const items = await getInterviewResults();
        if (active) setResults(items);
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 401) {
          logoutUser();
          navigate("/login", { replace: true });
          return;
        }
        setError(requestError.message || "Your results could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadResults();
    return () => { active = false; };
  }, [navigate, reload]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 sm:space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] theme-text-accent">YOUR PROGRESS</p>
          <h1 className="mb-2 font-[Manrope,sans-serif] text-2xl font-bold tracking-tight theme-text-primary sm:text-3xl">Interview Results</h1>
          <p className="mb-0 max-w-2xl text-sm leading-6 theme-text-secondary">Review completed practice sessions and their saved AI evaluations.</p>
        </div>
        <Link to="/interviews" className="inline-flex min-h-11 w-fit items-center justify-center rounded-xl border theme-border theme-card-surface px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Browse interviews</Link>
      </header>

      {loading ? (
        <section className="space-y-3" role="status" aria-live="polite" aria-label="Loading interview results">
          {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl border theme-border theme-card-surface" />)}
          <span className="sr-only">Loading interview results...</span>
        </section>
      ) : error ? (
        <section className="rounded-2xl border theme-border-error theme-error-surface p-6 text-center" role="alert">
          <h2 className="mb-2 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Results unavailable</h2>
          <p className="mb-5 text-sm theme-text-error">{error}</p>
          <button type="button" onClick={() => setReload((count) => count + 1)} className="inline-flex min-h-10 items-center justify-center rounded-xl theme-primary-button px-4 py-2.5 text-sm font-semibold theme-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Try again</button>
        </section>
      ) : results.length === 0 ? (
        <section className="rounded-2xl border theme-border theme-card-surface px-6 py-12 text-center sm:px-10">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent" aria-hidden="true">◎</span>
          <h2 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">No interview results yet</h2>
          <p className="mx-auto mb-6 max-w-lg text-sm leading-6 theme-text-secondary">Complete a mock interview to find its saved session and evaluation here.</p>
          <Link to="/interviews" className="inline-flex min-h-11 items-center justify-center rounded-xl theme-primary-button px-5 py-3 text-sm font-bold theme-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Choose an interview</Link>
        </section>
      ) : (
        <section className="space-y-3" aria-label="Saved interview results">
          {results.map((result) => {
            const isCompleted = result.status === "completed";
            const evaluationStatus = result.evaluationStatus || "not-requested";
            const href = isCompleted ? `/results/${result._id}` : `/mock-session/${result._id}`;
            const title = result.interview?.title || "Mock interview session";
            return (
              <Link key={result._id} to={href} className="group flex flex-col gap-4 rounded-2xl border theme-border theme-card-surface p-5 shadow-sm transition theme-hover-border theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <div className="min-w-0">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide theme-text-muted">{isCompleted ? "Completed session" : "In progress"} <span aria-hidden="true">·</span> {formatDate(result.completedAt || result.startedAt || result.createdAt)}</p>
                  <h2 className="mb-1 truncate font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">{title}</h2>
                  <p className="mb-0 text-sm theme-text-secondary">{result.totalQuestions ?? result.answers?.length ?? 0} questions</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  {isCompleted && <span className="rounded-full theme-accent-soft-surface px-3 py-1.5 text-xs font-semibold theme-text-accent">{statusLabels[evaluationStatus] || "Evaluation status unavailable"}</span>}
                  {typeof result.overallScore === "number" && <span className="font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">{result.overallScore}<span className="text-xs font-medium theme-text-muted"> / 100</span></span>}
                  <span className="text-sm font-semibold theme-text-accent">{isCompleted ? "View result" : "Resume session"}<span className="ml-2" aria-hidden="true">→</span></span>
                </div>
              </Link>
            );
          })}
        </section>
      )}
    </div>
  );
}

export default ResultsPage;
