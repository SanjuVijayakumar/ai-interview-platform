import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { getAdminDashboardStats } from "../services/adminDashboardService.js";
import AdminDashboardOverview from "../components/admin/AdminDashboardOverview.jsx";

const initialState = { stats: null, error: false, loading: true };
const buttonClass = "theme-secondary-button theme-focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-70";
const timestamp = new Intl.DateTimeFormat("en", {
  dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
});

function DashboardSkeleton() {
  return (
    <div role="status" className="space-y-5">
      <p className="sr-only">Loading dashboard statistics</p>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="theme-card-surface rounded-2xl border p-4">
            <div className="mb-3 h-3 w-2/3 rounded bg-[var(--color-bg-elevated)]" />
            <div className="h-8 w-1/3 rounded bg-[var(--color-bg-elevated)]" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="theme-card-surface h-56 rounded-2xl border" />
    </div>
  );
}

function Dashboard({ capability }) {
  const [state, setState] = useState(initialState);
  const pending = useRef(null);

  const load = useCallback(async () => {
    if (pending.current || !capability?.isCurrent()) return;
    const controller = new AbortController();
    pending.current = controller;
    const canPublish = () => pending.current === controller &&
      !controller.signal.aborted && capability.isCurrent();

    setState((previous) => ({ ...previous, error: false, loading: true }));
    try {
      const stats = await getAdminDashboardStats({ capability, signal: controller.signal });
      if (canPublish()) setState({ stats, error: false, loading: false });
    } catch {
      if (canPublish()) setState((previous) => ({ ...previous, error: true, loading: false }));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [capability]);

  useEffect(() => {
    let mounted = true;
    // Defer dispatch so a development Strict Mode effect replay sends only one request.
    queueMicrotask(() => { if (mounted) void load(); });
    return () => {
      mounted = false;
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    };
  }, [load]);

  const { stats, error, loading } = state;
  return (
    <div className="space-y-6 theme-text-primary">
      <header className="theme-welcome-card flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5 sm:p-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Admin Dashboard</h2>
          <p className="mt-1 text-sm theme-text-secondary">Platform overview of accounts, interview practice, and evaluations.</p>
          {stats && <p className="mt-3 text-xs theme-text-secondary">
            Last updated <time dateTime={stats.generatedAt}>{timestamp.format(new Date(stats.generatedAt))} UTC</time>
          </p>}
        </div>
        <button type="button" className={buttonClass} onClick={load} disabled={loading}>
          <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10a8 8 0 0 0-14-3L3 10m0-6v6h6m-5 4a8 8 0 0 0 14 3l3-3m0 6v-6h-6" />
          </svg>
          {loading && stats ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error && (
        <div className="theme-error-surface theme-border-error flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p role="alert" className="text-sm theme-text-error">
            {stats ? "Refresh failed. Showing previously loaded statistics." : "Dashboard statistics could not be loaded."}
          </p>
          <button type="button" className={buttonClass} onClick={load}>Retry</button>
        </div>
      )}
      {loading && !stats && <DashboardSkeleton />}
      {stats && <AdminDashboardOverview stats={stats} />}
    </div>
  );
}

export default function AdminDashboardPage() {
  const { capability } = useOutletContext();
  // The protected boundary unmounts this route whenever authorization is replaced.
  return <Dashboard capability={capability} />;
}
