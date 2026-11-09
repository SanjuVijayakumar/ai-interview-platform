import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getMockSession } from "../services/mockSessionService.js";

function getQuestionKey(question, index) {
  return String(question.question || index);
}

function MockSessionPage() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      setLoading(true);
      setError("");
      setSession(null);
      setAnswers({});
      setCurrentIndex(0);

      try {
        const result = await getMockSession(sessionId);
        if (!result || !Array.isArray(result.answers)) {
          throw new Error("The session data was not in the expected format.");
        }
        if (result.answers.some((answer) => !answer || typeof answer.questionText !== "string")) {
          throw new Error("This session contains an invalid question snapshot.");
        }
        if (!active) return;

        const orderedAnswers = [...result.answers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setSession({ ...result, answers: orderedAnswers });
        setAnswers(Object.fromEntries(orderedAnswers.map((answer, index) => [
          getQuestionKey(answer, index),
          typeof answer.answerText === "string" ? answer.answerText : "",
        ])));
      } catch (requestError) {
        if (!active) return;
        const message = requestError.message || "Unable to load this mock interview session.";
        if (requestError.status === 401 || /session is missing|authentication|token|access denied|sign in/i.test(message)) {
          navigate("/login", { replace: true });
          return;
        }
        setError(message);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadSession();
    return () => { active = false; };
  }, [sessionId, retryCount, navigate]);

  const questions = session?.answers || [];
  const currentQuestion = questions[currentIndex];
  const interviewId = location.state?.interviewId || session?.interview?._id || session?.interview;
  const backPath = interviewId ? `/interviews/${encodeURIComponent(interviewId)}` : "/interviews";
  const backLabel = interviewId ? "Back to Interview Details" : "Back to Interviews";
  const answeredCount = useMemo(() => questions.reduce((count, question, index) => {
    return count + (answers[getQuestionKey(question, index)]?.trim() ? 1 : 0);
  }, 0), [questions, answers]);

  const updateCurrentAnswer = (value) => {
    if (!currentQuestion) return;
    const key = getQuestionKey(currentQuestion, currentIndex);
    setAnswers((current) => ({ ...current, [key]: value }));
  };

  if (loading) {
    return (
      <section className="mx-auto flex min-h-72 w-full max-w-5xl items-center justify-center gap-3 rounded-2xl border theme-border theme-card-surface p-6 text-sm theme-text-secondary" role="status" aria-live="polite">
        <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" />
        Loading mock interview session...
      </section>
    );
  }

  if (error) {
    return (
      <section className="mx-auto w-full max-w-3xl rounded-2xl border theme-border-error theme-error-surface p-6 text-center sm:p-8" role="alert">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.15em] theme-text-error">SESSION UNAVAILABLE</p>
        <h1 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">Could not load this session</h1>
        <p className="mb-6 text-sm leading-6 theme-text-error">{error}</p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <button type="button" onClick={() => setRetryCount((count) => count + 1)} className="inline-flex min-h-10 items-center justify-center rounded-xl theme-primary-button px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Try again</button>
          <Link to={backPath} className="inline-flex min-h-10 items-center justify-center rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">{backLabel}</Link>
        </div>
      </section>
    );
  }

  if (!session || questions.length === 0) {
    return (
      <section className="mx-auto w-full max-w-3xl rounded-2xl border theme-border theme-card-surface p-6 text-center sm:p-8">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">MOCK INTERVIEW</p>
        <h1 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">No questions in this session</h1>
        <p className="mb-6 text-sm leading-6 theme-text-secondary">This session has no saved question snapshots to display.</p>
        <Link to={backPath} className="inline-flex min-h-10 items-center justify-center rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">{backLabel}</Link>
      </section>
    );
  }

  const currentKey = getQuestionKey(currentQuestion, currentIndex);
  const progressPercent = ((currentIndex + 1) / questions.length) * 100;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 sm:space-y-6">
      <header className="flex flex-col gap-4 rounded-2xl border theme-border theme-card-surface p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">MOCK INTERVIEW</p>
          <h1 className="mb-1 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary sm:text-2xl">Interview practice session</h1>
          <p className="mb-0 text-sm theme-text-secondary">{session.status === "completed" ? "Completed session" : "In progress"} <span aria-hidden="true">·</span> {questions.length} {questions.length === 1 ? "question" : "questions"}</p>
        </div>
        <Link to={backPath} className="inline-flex min-h-10 w-full shrink-0 items-center justify-center rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary transition theme-hover-border theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring sm:w-auto">{backLabel}</Link>
      </header>

      <section className="overflow-hidden rounded-2xl border theme-border-highlight theme-card-surface shadow-sm" aria-labelledby="question-heading">
        <div className="border-b theme-border-subtle p-5 sm:p-7">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex rounded-full theme-accent-soft-surface px-3 py-1.5 text-sm font-bold theme-text-accent" aria-current="step">Question {currentIndex + 1} <span className="mx-1 theme-text-muted">/</span> {questions.length}</span>
            <span className="text-xs font-medium theme-text-secondary">{answeredCount} of {questions.length} answered</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full theme-inset-surface" role="progressbar" aria-label="Question progress" aria-valuemin={1} aria-valuemax={questions.length} aria-valuenow={currentIndex + 1}>
            <div className="h-full rounded-full theme-primary-button transition-[width] duration-300" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Question progress">
            {questions.map((question, index) => (
              <button
                key={getQuestionKey(question, index)}
                type="button"
                onClick={() => setCurrentIndex(index)}
                aria-label={`Go to question ${index + 1}${answers[getQuestionKey(question, index)]?.trim() ? ", answered" : ""}`}
                aria-current={index === currentIndex ? "step" : undefined}
                className={`grid h-9 w-9 place-items-center rounded-lg border text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 theme-focus-ring ${index === currentIndex ? "theme-primary-button theme-text-primary theme-border-highlight shadow-sm" : answers[getQuestionKey(question, index)]?.trim() ? "theme-accent-soft-surface theme-border-highlight theme-text-accent" : "theme-inset-surface theme-border-subtle theme-text-secondary theme-hover-surface"}`}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5 sm:p-7">
          <div className="mb-4 flex flex-wrap gap-2">
            {currentQuestion.category && <span className="rounded-full theme-accent-soft-surface px-3 py-1.5 text-xs font-semibold theme-text-accent">{currentQuestion.category}</span>}
            {currentQuestion.difficulty && <span className="rounded-full theme-inset-surface px-3 py-1.5 text-xs font-semibold theme-text-secondary">{currentQuestion.difficulty}</span>}
          </div>
          <h2 id="question-heading" className="mb-6 whitespace-pre-wrap font-[Manrope,sans-serif] text-xl font-bold leading-relaxed theme-text-primary sm:text-2xl">{currentQuestion.questionText}</h2>

          <label htmlFor="mock-answer" className="mb-2 block text-sm font-semibold theme-text-primary">Your answer</label>
          <textarea
            id="mock-answer"
            value={answers[currentKey] || ""}
            onChange={(event) => updateCurrentAnswer(event.target.value)}
            placeholder="Take a moment to structure your response, then write it here..."
            rows={10}
            className="min-h-64 w-full resize-y rounded-xl border theme-border theme-inset-surface px-4 py-3 text-sm leading-7 theme-text-primary outline-none transition placeholder:theme-text-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20 sm:min-h-80 sm:px-5 sm:py-4"
          />
          <p className="mb-0 mt-2 text-xs theme-text-muted">Your draft stays in this page for now and is not saved to your account.</p>
        </div>

        <footer className="flex flex-col-reverse gap-3 border-t theme-border-subtle p-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <button type="button" onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))} disabled={currentIndex === 0} className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border theme-border px-5 py-2.5 text-sm font-semibold theme-text-secondary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">Previous</button>
          <span className="text-center text-xs theme-text-muted">Question {currentIndex + 1} of {questions.length}</span>
          <button type="button" onClick={() => setCurrentIndex((index) => Math.min(questions.length - 1, index + 1))} disabled={currentIndex === questions.length - 1} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-2.5 text-sm font-bold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">Next</button>
        </footer>
      </section>
    </main>
  );
}

export default MockSessionPage;
