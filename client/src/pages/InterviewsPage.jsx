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
  if (status === "completed") return "bg-emerald-50 text-emerald-700";
  if (status === "in-progress") return "bg-indigo-50 text-indigo-700";
  return "bg-amber-50 text-amber-700";
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
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">PRACTICE LIBRARY</p>
          <h1 className="mb-2 font-[Manrope,sans-serif] text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">My interviews</h1>
          <p className="mb-0 max-w-2xl text-sm leading-6 text-slate-500">Create and manage your interview practice sessions in one place.</p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Create interview
        </button>
      </section>

      {notice && <p className="mb-0 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{notice}</p>}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Interview list controls">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="mb-1 text-sm font-medium text-slate-500">Total interviews</p>
            <p className="mb-0 font-[Manrope,sans-serif] text-3xl font-bold tracking-tight text-slate-900" aria-live="polite">{loading ? "…" : loadError ? "—" : interviews.length}</p>
          </div>
          <div className="grid w-full gap-3 sm:max-w-xl sm:grid-cols-[minmax(0,1fr)_190px]">
            <label className="relative block">
              <span className="sr-only">Search interviews by title</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
            </label>
            <label>
              <span className="sr-only">Filter by difficulty</span>
              <select value={difficultyFilter} onChange={(event) => setDifficultyFilter(event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">
                <option value="all">All difficulties</option>
                {difficulties.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      {loadError ? (
        <section className="rounded-2xl border border-rose-100 bg-rose-50 p-6 text-center" role="alert">
          <p className="mb-4 text-sm text-rose-700">{loadError}</p>
          <button type="button" onClick={loadInterviews} className="rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-100">Try again</button>
        </section>
      ) : loading ? (
        <section className="flex min-h-64 items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white text-sm text-slate-500" role="status">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-100 border-t-indigo-600" />Loading your interviews…
        </section>
      ) : interviews.length === 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm sm:px-10">
          <span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600"><svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></svg></span>
          <h2 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold text-slate-900">Your practice starts here</h2>
          <p className="mx-auto mb-6 max-w-md text-sm leading-6 text-slate-500">Create your first interview to start building confidence for your next opportunity.</p>
          <button type="button" onClick={openCreate} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700">Create your first interview</button>
        </section>
      ) : filteredInterviews.length === 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
          <h2 className="mb-2 font-[Manrope,sans-serif] text-lg font-bold text-slate-900">No matching interviews</h2>
          <p className="mb-0 text-sm text-slate-500">Try another title or difficulty filter.</p>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2" aria-label="Interviews">
          {filteredInterviews.map((interview) => (
            <article key={interview._id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClasses(interview.status)}`}>{displayStatus(interview.status)}</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{interview.difficulty}</span>
                  </div>
                  <h2 className="mb-1 break-words font-[Manrope,sans-serif] text-lg font-bold text-slate-900">{interview.title}</h2>
                  <p className="mb-4 text-sm text-slate-500">{interview.category}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-500">
                    <span><span className="font-medium text-slate-600">Created</span> {formatDate(interview.createdAt)}</span>
                    {interview.startedAt && <span><span className="font-medium text-slate-600">Started</span> {formatDate(interview.startedAt)}</span>}
                    {interview.completedAt && <span><span className="font-medium text-slate-600">Completed</span> {formatDate(interview.completedAt)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 sm:flex-col">
                  <button type="button" onClick={() => openEdit(interview)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Edit</button>
                  <button type="button" onClick={() => handleDelete(interview)} disabled={deletingId === interview._id} className="rounded-lg border border-rose-100 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-wait disabled:opacity-60">{deletingId === interview._id ? "Deleting…" : "Delete"}</button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="interview-form-title" className="my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-indigo-600">INTERVIEW DETAILS</p>
                <h2 id="interview-form-title" className="mb-0 font-[Manrope,sans-serif] text-xl font-bold text-slate-900">{editingInterview ? "Edit interview" : "Create interview"}</h2>
              </div>
              <button type="button" onClick={closeModal} disabled={saving} aria-label="Close form" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Interview title</span><input autoFocus required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Frontend Developer Practice" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" /></label>
              <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Category</span><input required value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Frontend Development" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" /></label>
              <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Difficulty</span><select required value={form.difficulty} onChange={(event) => setForm((current) => ({ ...current, difficulty: event.target.value }))} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">{difficulties.map((difficulty) => <option key={difficulty}>{difficulty}</option>)}</select></label>
              {editingInterview && <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Status</span><select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">{statuses.map((status) => <option key={status} value={status}>{displayStatus(status)}</option>)}</select></label>}
              {formError && <p className="mb-0 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2.5 text-sm text-rose-700" role="alert">{formError}</p>}
              <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeModal} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60">{saving && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}{saving ? "Saving…" : editingInterview ? "Save changes" : "Create interview"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default InterviewsPage;
