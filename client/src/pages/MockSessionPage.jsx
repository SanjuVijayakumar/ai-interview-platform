import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getMockSession, saveMockSessionAnswer } from "../services/mockSessionService.js";

function formatElapsedTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

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
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [saveStatuses, setSaveStatuses] = useState({});
  const saveStatesRef = useRef(new Map());
  const mountedRef = useRef(false);
  const activeSessionIdRef = useRef(sessionId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const state of saveStatesRef.current.values()) clearTimeout(state.timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      activeSessionIdRef.current = sessionId;
      setLoading(true);
      setError("");
      setSession(null);
      setAnswers({});
      setCurrentIndex(0);
      setSaveStatuses({});
      saveStatesRef.current.clear();

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

  useEffect(() => {
    if (!session?.startedAt) return undefined;
    const startedAt = new Date(session.startedAt).getTime();
    if (!Number.isFinite(startedAt)) return undefined;
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [session?.startedAt]);

  const questions = session?.answers || [];
  const currentQuestion = questions[currentIndex];
  const interviewId = location.state?.interviewId || session?.interview?._id || session?.interview;
  const backPath = interviewId ? `/interviews/${encodeURIComponent(interviewId)}` : "/interviews";
  const backLabel = interviewId ? "Back to Interview Details" : "Back to Interviews";
  const answeredCount = useMemo(() => questions.reduce((count, question, index) => {
    return count + (answers[getQuestionKey(question, index)]?.trim() ? 1 : 0);
  }, 0), [questions, answers]);

  const flushAnswer = async (key, questionId, state) => {
    if (!mountedRef.current || activeSessionIdRef.current !== sessionId || state.inFlight || state.version === state.savedVersion) return;
    state.inFlight = true;
    const requestVersion = state.version;
    const requestText = state.text;
    if (mountedRef.current && activeSessionIdRef.current === sessionId) setSaveStatuses((current) => ({ ...current, [key]: "saving" }));
    try {
      await saveMockSessionAnswer(sessionId, questionId, requestText);
      state.savedVersion = requestVersion;
      state.savedText = requestText;
      if (!mountedRef.current || activeSessionIdRef.current !== sessionId) return;
      if (state.version !== requestVersion) {
        setSaveStatuses((current) => ({ ...current, [key]: "saving" }));
        state.inFlight = false;
        await flushAnswer(key, questionId, state);
        return;
      }
      setSaveStatuses((current) => ({ ...current, [key]: "saved" }));
    } catch {
      if (mountedRef.current && activeSessionIdRef.current === sessionId && state.version === requestVersion) {
        setSaveStatuses((current) => ({ ...current, [key]: "failed" }));
      } else if (mountedRef.current && activeSessionIdRef.current === sessionId && state.version !== requestVersion) {
        state.inFlight = false;
        await flushAnswer(key, questionId, state);
        return;
      }
    } finally {
      state.inFlight = false;
    }
  };

  const updateCurrentAnswer = (value) => {
    if (!currentQuestion) return;
    const key = getQuestionKey(currentQuestion, currentIndex);
    setAnswers((current) => ({ ...current, [key]: value }));
    let state = saveStatesRef.current.get(key);
    if (!state) {
      state = { version: 0, savedVersion: 0, savedText: currentQuestion.answerText || "", text: currentQuestion.answerText || "", timer: null, inFlight: false };
      saveStatesRef.current.set(key, state);
    }
    state.text = value;
    state.version += 1;
    clearTimeout(state.timer);
    if (value === state.savedText) {
      state.savedVersion = state.version;
      setSaveStatuses((current) => ({ ...current, [key]: "saved" }));
      return;
    }
    setSaveStatuses((current) => ({ ...current, [key]: "pending" }));
    const questionId = String(currentQuestion.question);
    state.timer = setTimeout(() => { flushAnswer(key, questionId, state); }, 800);
  };

  const retryCurrentAnswer = () => {
    const state = saveStatesRef.current.get(currentKey);
    if (!state || !currentQuestion) return;
    clearTimeout(state.timer);
    state.timer = null;
    flushAnswer(currentKey, String(currentQuestion.question), state);
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
            <div className="flex items-center gap-3 text-xs font-medium theme-text-secondary">
              <span>Elapsed {formatElapsedTime(elapsedSeconds)}</span>
              <span>{answeredCount} of {questions.length} answered</span>
            </div>
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
          <div className="mt-2 flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs" aria-live="polite">
            {saveStatuses[currentKey] === "saving" || saveStatuses[currentKey] === "pending" ? <span className="theme-text-secondary">Saving...</span> : null}
            {saveStatuses[currentKey] === "saved" ? <span className="theme-text-accent">Saved</span> : null}
            {saveStatuses[currentKey] === "failed" ? <span className="theme-text-error">Save failed</span> : null}
            {saveStatuses[currentKey] === "failed" ? <button type="button" onClick={retryCurrentAnswer} className="font-semibold theme-text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Retry</button> : null}
            {!saveStatuses[currentKey] ? <span className="theme-text-muted">Your answer is saved automatically.</span> : null}
          </div>
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
