import { useCallback, useEffect, useMemo, useState } from "react";
import { createInterview, deleteInterview, getInterviews, updateInterview } from "../services/interviewService.js";

const blankForm = { title: "", category: "", difficulty: "Beginner", status: "scheduled" };
const difficulties = ["Beginner", "Intermediate", "Advanced"];
const statuses = ["scheduled", "in-progress", "completed"];

function formatDate(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function statusClasses(status) {
  if (status === "completed") return "theme-status-success";
  if (status === "in-progress") return "theme-status-info";
  return "theme-status-warning";
}

function displayStatus(status) {
  return status?.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Scheduled";
}

function InterviewsPage() {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInterview, setEditingInterview] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [deletingId, setDeletingId] = useState("");

  const loadInterviews = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const items = await getInterviews();
      setInterviews(items);
    } catch (error) {
      setLoadError(error.message || "We couldn't load your interviews. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInterviews(); }, [loadInterviews]);

  const filteredInterviews = useMemo(() => {
    const query = search.trim().toLowerCase();
    return interviews.filter((interview) => {
      const matchesTitle = !query || interview.title?.toLowerCase().includes(query);
      const matchesDifficulty = difficultyFilter === "all" || interview.difficulty === difficultyFilter;
      return matchesTitle && matchesDifficulty;
    });
  }, [interviews, search, difficultyFilter]);

  const openCreate = () => {
    setEditingInterview(null);
    setForm(blankForm);
    setFormError("");
    setModalOpen(true);
  };

  const openEdit = (interview) => {
    setEditingInterview(interview);
    setForm({
      title: interview.title || "",
      category: interview.category || "",
      difficulty: interview.difficulty || "Beginner",
      status: interview.status || "scheduled",
    });
    setFormError("");
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setFormError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError("");
    const title = form.title.trim();
    const category = form.category.trim();
    if (!title || !category) {
      setFormError("Enter an interview title and category.");
      return;
    }
    if (!difficulties.includes(form.difficulty)) {
      setFormError("Choose a valid difficulty.");
      return;
    }
    if (editingInterview && !statuses.includes(form.status)) {
      setFormError("Choose a valid interview status.");
      return;
    }

    setSaving(true);
    try {
      const payload = { title, category, difficulty: form.difficulty };
      if (editingInterview) payload.status = form.status;
      if (editingInterview) {
        await updateInterview(editingInterview._id, payload);
      } else {
        await createInterview(payload);
      }
      setModalOpen(false);
      setNotice(editingInterview ? "Interview updated." : "Interview created.");
      await loadInterviews();
    } catch (error) {
      setFormError(error.message || "We couldn't save this interview. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (interview) => {
    const confirmed = window.confirm(`Delete “${interview.title}”? This action cannot be undone.`);
    if (!confirmed) return;
    setDeletingId(interview._id);
    setNotice("");
    try {
      await deleteInterview(interview._id);
      setNotice("Interview deleted.");
      await loadInterviews();
    } catch (error) {
      setLoadError(error.message || "We couldn't delete this interview. Please try again.");
    } finally {
      setDeletingId("");
    }
  };

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] theme-text-accent">PRACTICE LIBRARY</p>
          <h1 className="mb-2 font-[Manrope,sans-serif] text-2xl font-bold tracking-tight theme-text-primary sm:text-3xl">My interviews</h1>
          <p className="mb-0 max-w-2xl text-sm leading-6 theme-text-secondary">Create and manage your interview practice sessions in one place.</p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-semibold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Create interview
        </button>
      </section>

      {notice && <p className="mb-0 rounded-xl border theme-border-success theme-success-surface px-4 py-3 text-sm theme-text-success" role="status">{notice}</p>}

      <section className="rounded-2xl border theme-border theme-card-surface p-5 shadow-sm sm:p-6" aria-label="Interview list controls">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="mb-1 text-sm font-medium theme-text-secondary">Total interviews</p>
            <p className="mb-0 font-[Manrope,sans-serif] text-3xl font-bold tracking-tight theme-text-primary" aria-live="polite">{loading ? "…" : loadError ? "—" : interviews.length}</p>
          </div>
          <div className="grid w-full gap-3 sm:max-w-xl sm:grid-cols-[minmax(0,1fr)_190px]">
            <label className="relative block">
              <span className="sr-only">Search interviews by title</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 theme-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" className="h-11 w-full rounded-xl border theme-border theme-card-surface pl-10 pr-3 text-sm theme-text-primary outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" />
            </label>
            <label>
              <span className="sr-only">Filter by difficulty</span>
              <select value={difficultyFilter} onChange={(event) => setDifficultyFilter(event.target.value)} className="h-11 w-full rounded-xl border theme-border theme-card-surface px-3 text-sm theme-text-primary outline-none transition theme-input-focus focus:ring-2 theme-input-focus">
                <option value="all">All difficulties</option>
                {difficulties.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      {loadError ? (
        <section className="rounded-2xl border theme-border-error theme-error-surface p-6 text-center" role="alert">
          <p className="mb-4 text-sm theme-text-error">{loadError}</p>
          <button type="button" onClick={loadInterviews} className="rounded-lg border theme-border-error theme-card-surface px-4 py-2 text-sm font-semibold theme-text-error transition theme-hover-error-surface">Try again</button>
        </section>
      ) : loading ? (
        <section className="flex min-h-64 items-center justify-center gap-3 rounded-2xl border theme-border theme-card-surface text-sm theme-text-secondary" role="status">
          <span className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" />Loading your interviews…
        </section>
      ) : interviews.length === 0 ? (
        <section className="rounded-2xl border theme-border theme-card-surface px-6 py-12 text-center shadow-sm sm:px-10">
          <span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent"><svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></svg></span>
          <h2 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">Your practice starts here</h2>
          <p className="mx-auto mb-6 max-w-md text-sm leading-6 theme-text-secondary">Create your first interview to start building confidence for your next opportunity.</p>
          <button type="button" onClick={openCreate} className="rounded-xl theme-primary-button px-5 py-3 text-sm font-semibold theme-text-primary transition theme-hover-primary">Create your first interview</button>
        </section>
      ) : filteredInterviews.length === 0 ? (
        <section className="rounded-2xl border theme-border theme-card-surface px-6 py-12 text-center shadow-sm">
          <h2 className="mb-2 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">No matching interviews</h2>
          <p className="mb-0 text-sm theme-text-secondary">Try another title or difficulty filter.</p>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2" aria-label="Interviews">
          {filteredInterviews.map((interview) => (
            <article key={interview._id} className="rounded-2xl border theme-border theme-card-surface p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClasses(interview.status)}`}>{displayStatus(interview.status)}</span>
                    <span className="rounded-full theme-inset-surface px-3 py-1 text-xs font-medium theme-text-secondary">{interview.difficulty}</span>
                  </div>
                  <h2 className="mb-1 break-words font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">{interview.title}</h2>
                  <p className="mb-4 text-sm theme-text-secondary">{interview.category}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs theme-text-secondary">
                    <span><span className="font-medium theme-text-secondary">Created</span> {formatDate(interview.createdAt)}</span>
                    {interview.startedAt && <span><span className="font-medium theme-text-secondary">Started</span> {formatDate(interview.startedAt)}</span>}
                    {interview.completedAt && <span><span className="font-medium theme-text-secondary">Completed</span> {formatDate(interview.completedAt)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 sm:flex-col">
                  <button type="button" onClick={() => openEdit(interview)} className="rounded-lg border theme-border px-3 py-2 text-xs font-semibold theme-text-primary transition theme-hover-border theme-hover-surface theme-hover-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Edit</button>
                  <button type="button" onClick={() => handleDelete(interview)} disabled={deletingId === interview._id} className="rounded-lg border theme-border-error px-3 py-2 text-xs font-semibold theme-text-error transition theme-hover-error-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-error-ring disabled:cursor-wait disabled:opacity-60">{deletingId === interview._id ? "Deleting…" : "Delete"}</button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto theme-modal-overlay p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="interview-form-title" className="my-auto w-full max-w-lg rounded-2xl border theme-border theme-card-surface p-5 shadow-xl sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] theme-text-accent">INTERVIEW DETAILS</p>
                <h2 id="interview-form-title" className="mb-0 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">{editingInterview ? "Edit interview" : "Create interview"}</h2>
              </div>
              <button type="button" onClick={closeModal} disabled={saving} aria-label="Close form" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg theme-text-secondary transition theme-hover-surface disabled:opacity-50"><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block"><span className="mb-1.5 block text-sm font-semibold theme-text-primary">Interview title</span><input autoFocus required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Frontend Developer Practice" className="h-11 w-full rounded-xl border theme-border px-3 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" /></label>
              <label className="block"><span className="mb-1.5 block text-sm font-semibold theme-text-primary">Category</span><input required value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Frontend Development" className="h-11 w-full rounded-xl border theme-border px-3 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" /></label>
              <label className="block"><span className="mb-1.5 block text-sm font-semibold theme-text-primary">Difficulty</span><select required value={form.difficulty} onChange={(event) => setForm((current) => ({ ...current, difficulty: event.target.value }))} className="h-11 w-full rounded-xl border theme-border theme-card-surface px-3 text-sm outline-none transition theme-input-focus focus:ring-2 theme-input-focus">{difficulties.map((difficulty) => <option key={difficulty}>{difficulty}</option>)}</select></label>
              {editingInterview && <label className="block"><span className="mb-1.5 block text-sm font-semibold theme-text-primary">Status</span><select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))} className="h-11 w-full rounded-xl border theme-border theme-card-surface px-3 text-sm outline-none transition theme-input-focus focus:ring-2 theme-input-focus">{statuses.map((status) => <option key={status} value={status}>{displayStatus(status)}</option>)}</select></label>}
              {formError && <p className="mb-0 rounded-lg border theme-border-error theme-error-surface px-3 py-2.5 text-sm theme-text-error" role="alert">{formError}</p>}
              <div className="flex flex-col-reverse gap-2 border-t theme-border-subtle pt-4 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeModal} disabled={saving} className="rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-secondary transition theme-hover-surface disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-primary disabled:cursor-wait disabled:opacity-60">{saving && <span className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />}{saving ? "Saving…" : editingInterview ? "Save changes" : "Create interview"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default InterviewsPage;
