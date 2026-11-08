import { Link, useLocation, useParams } from "react-router-dom";

function formatDate(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function displayStatus(status) {
  return status?.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Status unavailable";
}

function statusClasses(status) {
  if (status === "completed") return "theme-status-success";
  if (status === "in-progress") return "theme-status-info";
  return "theme-status-warning";
}

function DetailItem({ label, children }) {
  return (
    <div className="min-w-0 rounded-xl border theme-border-subtle theme-inset-surface p-4">
      <dt className="mb-1.5 text-xs font-semibold uppercase tracking-wide theme-text-secondary">{label}</dt>
      <dd className="mb-0 break-words text-sm font-semibold theme-text-primary">{children}</dd>
    </div>
  );
}

function InterviewDetailsPage() {
  const { interviewId } = useParams();
  const { state } = useLocation();
  const interview = state?.interview;

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] theme-text-accent">PRACTICE LIBRARY</p>
          <h2 className="mb-2 font-[Manrope,sans-serif] text-2xl font-bold tracking-tight theme-text-primary sm:text-3xl">Interview Details</h2>
          <p className="mb-0 max-w-2xl text-sm leading-6 theme-text-secondary">Review the setup for this practice session and manage its questions.</p>
        </div>
        <Link to="/interviews" className="inline-flex min-h-11 w-fit shrink-0 items-center justify-center gap-2 rounded-xl border theme-border theme-card-surface px-4 py-2.5 text-sm font-semibold theme-text-primary shadow-sm transition theme-hover-border theme-hover-surface theme-hover-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></svg>
          Back to Interviews
        </Link>
      </section>

      <section className="rounded-2xl border theme-border theme-card-surface p-5 shadow-sm sm:p-6" aria-labelledby="interview-info-heading">
        <div className="mb-5 border-b theme-border-subtle pb-4">
          <h3 id="interview-info-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Interview information</h3>
          <p className="mb-0 text-sm theme-text-secondary">Key details for this interview session.</p>
        </div>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DetailItem label="Interview title">{interview?.title || "Interview title unavailable"}</DetailItem>
          <DetailItem label="Category">{interview?.category || "Category unavailable"}</DetailItem>
          <DetailItem label="Difficulty">{interview?.difficulty || "Difficulty unavailable"}</DetailItem>
          <DetailItem label="Status"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses(interview?.status)}`}>{displayStatus(interview?.status)}</span></DetailItem>
          <DetailItem label="Created date"><time dateTime={interview?.createdAt || undefined}>{formatDate(interview?.createdAt)}</time></DetailItem>
          {interviewId && <DetailItem label="Interview ID">{interviewId}</DetailItem>}
        </dl>
      </section>

      <section className="overflow-hidden rounded-2xl border theme-border theme-card-surface shadow-sm" aria-labelledby="questions-heading">
        <div className="flex flex-col gap-4 border-b theme-border-subtle px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 id="questions-heading" className="mb-0 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Question Management</h3>
              <span className="rounded-full theme-accent-soft-surface px-2.5 py-1 text-xs font-semibold theme-text-accent" aria-label="Total questions: 0">0 questions</span>
            </div>
            <p className="mb-0 text-sm theme-text-secondary">Build a focused question set for your practice.</p>
          </div>
          <button type="button" title="Question management is coming soon" className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-4 py-2.5 text-sm font-semibold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add Question
          </button>
        </div>
        <div className="flex min-h-64 flex-col items-center justify-center px-5 py-10 text-center sm:min-h-72 sm:px-8">
          <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent">
            <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>
          </span>
          <h4 className="mb-2 font-[Manrope,sans-serif] text-base font-bold theme-text-primary">No questions added yet</h4>
          <p className="mb-0 max-w-md text-sm leading-6 theme-text-secondary">Questions for this interview will appear here. Add questions to create a focused practice session.</p>
        </div>
      </section>
    </div>
  );
}

export default InterviewDetailsPage;





