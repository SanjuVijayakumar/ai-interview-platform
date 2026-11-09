import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getInterviewById } from "../services/interviewService.js";
import { createQuestion, deleteQuestion, getQuestions, updateQuestion } from "../services/questionService.js";

const blankQuestionForm = { questionText: "", category: "", difficulty: "Beginner", order: "1", expectedAnswer: "" };
const difficulties = ["Beginner", "Intermediate", "Advanced"];

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
  const navigate = useNavigate();
  const [interview, setInterview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [questions, setQuestions] = useState([]);
  const [questionsLoading, setQuestionsLoading] = useState(true);
  const [questionsError, setQuestionsError] = useState("");
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [questionForm, setQuestionForm] = useState(blankQuestionForm);
  const [questionSaving, setQuestionSaving] = useState(false);
  const [questionFormError, setQuestionFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [deletingQuestionId, setDeletingQuestionId] = useState("");

  useEffect(() => {
    let active = true;

    async function loadInterview() {
      setLoading(true);
      setError("");
      setInterview(null);

      try {
        const result = await getInterviewById(interviewId);
        if (active) setInterview(result);
      } catch (requestError) {
        if (!active) return;
        const message = requestError.message || "Unable to load this interview. Please try again.";
        if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
          navigate("/login", { replace: true });
          return;
        }
        if (/invalid interview id/i.test(message)) {
          setError("This interview ID is invalid.");
        } else if (/interview not found/i.test(message)) {
          setError("This interview was not found or does not belong to your account.");
        } else {
          setError(message);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadInterview();
    return () => { active = false; };
  }, [interviewId, navigate]);

  useEffect(() => {
    let active = true;

    async function loadQuestions() {
      if (!interviewId) {
        setQuestionsLoading(false);
        setQuestionsError("An interview ID is required to load questions.");
        return;
      }

      setQuestionsLoading(true);
      setQuestionsError("");
      setQuestions([]);

      try {
        const result = await getQuestions(interviewId);
        if (active) setQuestions(result);
      } catch (requestError) {
        if (!active) return;
        const message = requestError.message || "Unable to load questions. Please try again.";
        if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
          navigate("/login", { replace: true });
          return;
        }
        setQuestionsError(message);
      } finally {
        if (active) setQuestionsLoading(false);
      }
    }

    loadQuestions();
    return () => { active = false; };
  }, [interviewId, navigate]);

  const sortedQuestions = [...questions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const openQuestionModal = () => {
    setEditingQuestion(null);
    setQuestionForm(blankQuestionForm);
    setQuestionFormError("");
    setNotice("");
    setQuestionModalOpen(true);
  };

  const openEditQuestionModal = (question) => {
    setEditingQuestion(question);
    setQuestionForm({
      questionText: question.questionText || "",
      category: question.category || "",
      difficulty: question.difficulty || "Beginner",
      order: String(question.order ?? 1),
      expectedAnswer: question.expectedAnswer || "",
    });
    setQuestionFormError("");
    setNotice("");
    setQuestionModalOpen(true);
  };

  const closeQuestionModal = () => {
    if (questionSaving) return;
    setQuestionModalOpen(false);
    setEditingQuestion(null);
    setQuestionFormError("");
  };

  const handleQuestionSubmit = async (event) => {
    event.preventDefault();
    setQuestionFormError("");
    const questionText = questionForm.questionText.trim();
    const category = questionForm.category.trim();
    const order = Number(questionForm.order);
    if (!questionText || !category || !questionForm.order.trim()) {
      setQuestionFormError("Enter the question text, category, and order.");
      return;
    }
    if (!difficulties.includes(questionForm.difficulty)) {
      setQuestionFormError("Choose a valid difficulty.");
      return;
    }
    if (!Number.isInteger(order) || order < 1) {
      setQuestionFormError("Order must be a whole number of at least 1.");
      return;
    }

    setQuestionSaving(true);
    setNotice("");
    try {
      const editableFields = {
        questionText,
        category,
        difficulty: questionForm.difficulty,
        order,
        expectedAnswer: questionForm.expectedAnswer.trim(),
      };
      if (editingQuestion) {
        await updateQuestion(editingQuestion._id, editableFields);
      } else {
        await createQuestion({ ...editableFields, interview: interviewId });
      }
      setQuestionModalOpen(false);
      setEditingQuestion(null);
      setQuestionForm(blankQuestionForm);
      setNotice(editingQuestion ? "Question updated successfully." : "Question created successfully.");
      setQuestionsLoading(true);
      setQuestionsError("");
      try {
        setQuestions(await getQuestions(interviewId));
      } catch (refreshError) {
        const message = refreshError.message || "Question was created, but the list could not be refreshed.";
        if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
          navigate("/login", { replace: true });
          return;
        }
        setQuestionsError(message);
      } finally {
        setQuestionsLoading(false);
      }
    } catch (requestError) {
      const message = requestError.message || "Unable to create this question. Please try again.";
      if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
        navigate("/login", { replace: true });
        return;
      }
      setQuestionFormError(message);
    } finally {
      setQuestionSaving(false);
    }
  };

  const handleDeleteQuestion = async (question) => {
    const confirmed = window.confirm(`Delete “${question.questionText}”? This action cannot be undone.`);
    if (!confirmed) return;

    setDeletingQuestionId(question._id);
    setNotice("");
    setActionError("");
    try {
      await deleteQuestion(question._id);
      setNotice("Question deleted successfully.");
      setQuestionsLoading(true);
      setQuestionsError("");
      try {
        setQuestions(await getQuestions(interviewId));
      } catch (refreshError) {
        const message = refreshError.message || "Question was deleted, but the list could not be refreshed.";
        if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
          navigate("/login", { replace: true });
          return;
        }
        setActionError(message);
      } finally {
        setQuestionsLoading(false);
      }
    } catch (requestError) {
      const message = requestError.message || "Unable to delete this question. Please try again.";
      if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
        navigate("/login", { replace: true });
        return;
      }
      setActionError(message);
    } finally {
      setDeletingQuestionId("");
    }
  };

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

      {loading ? (
        <section className="flex min-h-64 items-center justify-center gap-3 rounded-2xl border theme-border theme-card-surface text-sm theme-text-secondary" role="status" aria-live="polite">
          <span className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" aria-hidden="true" />
          Loading interview details…
        </section>
      ) : error ? (
        <section className="rounded-2xl border theme-border-error theme-error-surface p-6 text-center" role="alert">
          <p className="mb-4 text-sm theme-text-error">{error}</p>
          <Link to="/interviews" className="inline-flex min-h-10 items-center justify-center rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-surface">Back to Interviews</Link>
        </section>
      ) : interview ? (
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
          {interview._id && <DetailItem label="Interview ID">{interview._id}</DetailItem>}
        </dl>
      </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border theme-border theme-card-surface shadow-sm" aria-labelledby="questions-heading">
        <div className="flex flex-col gap-4 border-b theme-border-subtle px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 id="questions-heading" className="mb-0 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Question Management</h3>
              <span className="rounded-full theme-accent-soft-surface px-2.5 py-1 text-xs font-semibold theme-text-accent" aria-label={`Total questions: ${questions.length}`}>
                {questions.length} {questions.length === 1 ? "question" : "questions"}
              </span>
            </div>
            <p className="mb-0 text-sm theme-text-secondary">Build a focused question set for your practice.</p>
          </div>
          <button type="button" onClick={openQuestionModal} disabled={!interviewId} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-4 py-2.5 text-sm font-semibold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add Question
          </button>
        </div>
        {questionsLoading ? (
          <div className="flex min-h-64 items-center justify-center gap-3 px-5 py-10 text-sm theme-text-secondary" role="status" aria-live="polite">
            <span className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" aria-hidden="true" />
            Loading questions...
          </div>
        ) : questionsError ? (
          <div className="m-5 rounded-xl border theme-border-error theme-error-surface p-5 text-center sm:m-6" role="alert">
            <p className="mb-0 text-sm theme-text-error">{questionsError}</p>
          </div>
        ) : sortedQuestions.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-5 py-10 text-center sm:min-h-72 sm:px-8">
            <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent">
              <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>
            </span>
            <h4 className="mb-2 font-[Manrope,sans-serif] text-base font-bold theme-text-primary">No questions added yet</h4>
            <p className="mb-0 max-w-md text-sm leading-6 theme-text-secondary">Questions for this interview will appear here. Add questions to create a focused practice session.</p>
          </div>
        ) : (
          <ol className="grid list-none gap-4 p-5 sm:p-6">
            {sortedQuestions.map((question, index) => (
              <li key={question._id || `${question.order}-${index}`}>
                <article className="rounded-xl border theme-border-subtle theme-inset-surface p-5 transition sm:p-6">
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full theme-accent-soft-surface px-2.5 py-1 text-xs font-semibold theme-text-accent">Question {question.order}</span>
                      <span className="rounded-full theme-card-surface px-2.5 py-1 text-xs font-medium theme-text-secondary">{question.category}</span>
                      <span className="rounded-full theme-card-surface px-2.5 py-1 text-xs font-medium theme-text-secondary">{question.difficulty}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button type="button" onClick={() => openEditQuestionModal(question)} disabled={Boolean(deletingQuestionId)} className="rounded-lg border theme-border px-3 py-1.5 text-xs font-semibold theme-text-secondary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-60">Edit</button>
                      <button type="button" onClick={() => handleDeleteQuestion(question)} disabled={Boolean(deletingQuestionId) || questionSaving} className="rounded-lg border theme-border-error px-3 py-1.5 text-xs font-semibold theme-text-error transition theme-hover-error-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-error-ring disabled:cursor-wait disabled:opacity-60">
                        {deletingQuestionId === question._id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                  <h4 className="mb-0 whitespace-pre-wrap text-base font-semibold leading-7 theme-text-primary">{question.questionText}</h4>
                  {question.expectedAnswer?.trim() && (
                    <div className="mt-5 border-t theme-border-subtle pt-4">
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide theme-text-secondary">Expected answer</p>
                      <p className="mb-0 whitespace-pre-wrap text-sm leading-6 theme-text-secondary">{question.expectedAnswer}</p>
                    </div>
                  )}
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
      {notice && <p className="mb-0 rounded-xl border theme-border-success theme-success-surface px-4 py-3 text-sm theme-text-success" role="status">{notice}</p>}
      {actionError && <p className="mb-0 rounded-xl border theme-border-error theme-error-surface px-4 py-3 text-sm theme-text-error" role="alert">{actionError}</p>}

      {questionModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto theme-modal-overlay p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeQuestionModal(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="question-form-title" className="my-auto w-full max-w-2xl rounded-2xl border theme-border theme-card-surface p-5 shadow-xl sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] theme-text-accent">QUESTION DETAILS</p>
                <h2 id="question-form-title" className="mb-0 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">{editingQuestion ? "Edit question" : "Add a question"}</h2>
              </div>
              <button type="button" onClick={closeQuestionModal} disabled={questionSaving} aria-label="Close form" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg theme-text-secondary transition theme-hover-surface disabled:opacity-50">
                <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <form onSubmit={handleQuestionSubmit} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Question Text</span>
                <textarea autoFocus required rows="3" value={questionForm.questionText} onChange={(event) => setQuestionForm((current) => ({ ...current, questionText: event.target.value }))} placeholder="Enter the interview question" className="w-full resize-y rounded-xl border theme-border px-3 py-2.5 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Category</span>
                  <input required value={questionForm.category} onChange={(event) => setQuestionForm((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Behavioral" className="h-11 w-full rounded-xl border theme-border px-3 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Difficulty</span>
                  <select required value={questionForm.difficulty} onChange={(event) => setQuestionForm((current) => ({ ...current, difficulty: event.target.value }))} className="h-11 w-full rounded-xl border theme-border theme-card-surface px-3 text-sm outline-none transition theme-input-focus focus:ring-2 theme-input-focus">
                    {difficulties.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
                  </select>
                </label>
              </div>
              <label className="block sm:max-w-xs">
                <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Order</span>
                <input required type="number" min="1" step="1" value={questionForm.order} onChange={(event) => setQuestionForm((current) => ({ ...current, order: event.target.value }))} className="h-11 w-full rounded-xl border theme-border px-3 text-sm outline-none transition theme-input-focus focus:ring-2 theme-input-focus" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Expected Answer <span className="font-normal theme-text-secondary">(optional)</span></span>
                <textarea rows="3" value={questionForm.expectedAnswer} onChange={(event) => setQuestionForm((current) => ({ ...current, expectedAnswer: event.target.value }))} placeholder="Add guidance for a strong answer" className="w-full resize-y rounded-xl border theme-border px-3 py-2.5 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2 theme-input-focus" />
              </label>
              {questionFormError && <p className="mb-0 rounded-lg border theme-border-error theme-error-surface px-3 py-2.5 text-sm theme-text-error" role="alert">{questionFormError}</p>}
              <div className="flex flex-col-reverse gap-2 border-t theme-border-subtle pt-4 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeQuestionModal} disabled={questionSaving} className="rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-secondary transition theme-hover-surface disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={questionSaving} className="inline-flex items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-primary disabled:cursor-wait disabled:opacity-60">
                  {questionSaving && <span className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" aria-hidden="true" />}
                  {questionSaving ? "Saving..." : editingQuestion ? "Save changes" : "Add Question"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default InterviewDetailsPage;





