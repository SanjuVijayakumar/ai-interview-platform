import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getEvaluationStatus, getInterviewResult, requestEvaluation } from "../services/resultService.js";
import { logoutUser } from "../services/authService.js";

const STATUS_COPY = {
  "not-requested": "Your answers are saved. Start an evaluation when you are ready.",
  pending: "Your answers are being reviewed. This page will update when the evaluation is ready.",
  completed: "Evaluation complete. Your score and feedback are saved to this session.",
  failed: "The evaluation could not be completed. Your answers are still saved.",
};

const STATUS_POLL_MS = 1400;
const UNKNOWN_OUTCOME = "The evaluation outcome could not be confirmed. Check its status before submitting again.";

function isCurrentCapability(capability) {
  try {
    return typeof capability?.fetch === "function" && capability.isCurrent() === true;
  } catch {
    return false;
  }
}

function isTerminated(error) {
  return error?.status === 401 || ["unauthorized", "stale-session", "cancelled"].includes(error?.category);
}

function evaluationRequestMessage(error) {
  switch (error.status) {
    case 400: return "This result could not be submitted for evaluation.";
    case 403: return "You do not have permission to evaluate this result.";
    case 404: return "This result is unavailable.";
    case 429: return "The evaluation rate limit was reached. Try again later.";
    default: return "The evaluation request could not be completed.";
  }
}

export function CapabilityBoundEvaluationResultPage({ capability }) {
  const { resultId } = useParams();
  const [origin] = useState(() => capability);
  if (capability !== origin || !isCurrentCapability(origin)) {
    return <p role="alert">The authentication session for this result is unavailable.</p>;
  }
  return <BoundEvaluationLifecycle key={resultId} capability={origin} resultId={resultId} />;
}

function BoundEvaluationLifecycle({ capability, resultId }) {
  const [result, setResult] = useState(null);
  const [evaluationState, setEvaluationState] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [needsStatusCheck, setNeedsStatusCheck] = useState(false);
  const lifecycleRef = useRef(null);
  const actionLock = useRef(false);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      lifecycleRef.current = null;
      controller.abort();
    };
  }, []);

  const isActive = useCallback((lifecycle) =>
    lifecycle !== null && lifecycleRef.current === lifecycle && isCurrentCapability(capability),
  [capability]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    async function load() {
      if (!isActive(lifecycle)) return;
      const options = { capability, signal: lifecycle.signal };
      try {
        const [saved, status] = await Promise.all([
          getInterviewResult(resultId, options),
          getEvaluationStatus(resultId, options),
        ]);
        if (!isActive(lifecycle)) return;
        setResult(saved);
        setEvaluationState(status);
      } catch (requestError) {
        if (!isActive(lifecycle) || isTerminated(requestError)) return;
        setError(requestError.status === 403
          ? "You do not have permission to view this result."
          : "This result could not be loaded.");
      }
    }
    queueMicrotask(load);
  }, [capability, isActive, resultId]);

  const shouldPoll = evaluationState?.status === "pending" && !needsStatusCheck;
  useEffect(() => {
    if (!shouldPoll) return;
    const lifecycle = lifecycleRef.current;
    let active = true;
    let timer;
    const canPoll = () => active && isActive(lifecycle);

    async function poll() {
      if (!canPoll()) return;
      try {
        const status = await getEvaluationStatus(resultId, { capability, signal: lifecycle.signal });
        if (!canPoll()) return;
        setEvaluationState(status);
        if (status.status === "pending") timer = setTimeout(poll, STATUS_POLL_MS);
      } catch (requestError) {
        if (!canPoll() || isTerminated(requestError)) return;
        setActionError("Evaluation status could not be refreshed.");
        setNeedsStatusCheck(true);
      }
    }

    timer = setTimeout(poll, STATUS_POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [capability, isActive, resultId, shouldPoll]);

  async function recoverStatus(lifecycle, fallback = "") {
    if (!isActive(lifecycle)) return;
    try {
      const status = await getEvaluationStatus(resultId, { capability, signal: lifecycle.signal });
      if (!isActive(lifecycle)) return;
      setEvaluationState(status);
      setNeedsStatusCheck(false);
      setActionError(status.status === "not-requested" ? fallback : "");
    } catch (requestError) {
      if (!isActive(lifecycle) || isTerminated(requestError)) return;
      setNeedsStatusCheck(true);
      setActionError("Evaluation status could not be confirmed. Check the status again.");
    }
  }

  async function checkStatus() {
    const lifecycle = lifecycleRef.current;
    if (!needsStatusCheck || actionLock.current || !isActive(lifecycle)) return;
    actionLock.current = true;
    setCheckingStatus(true);
    try {
      await recoverStatus(lifecycle);
    } finally {
      if (isActive(lifecycle)) {
        actionLock.current = false;
        setCheckingStatus(false);
      }
    }
  }

  async function handleEvaluationRequest(retry) {
    const lifecycle = lifecycleRef.current;
    const eligible = retry === true
      ? evaluationState?.status === "failed" && evaluationState.retryAvailable === true
      : retry === false && evaluationState?.status === "not-requested";
    if (!eligible || result?.status !== "completed" || needsStatusCheck || actionLock.current || !isActive(lifecycle)) return;
    actionLock.current = true;
    setSubmitting(true);
    setActionError("");
    try {
      const status = await requestEvaluation(resultId, retry, { capability, signal: lifecycle.signal });
      if (isActive(lifecycle)) setEvaluationState(status);
    } catch (requestError) {
      if (!isActive(lifecycle) || isTerminated(requestError)) return;
      if (requestError.status === 409 || requestError.status === 502) {
        await recoverStatus(lifecycle, evaluationRequestMessage(requestError));
      } else if (requestError.status >= 500 || ["network-error", "request-error", "body-read-error", "malformed-response"].includes(requestError.category)) {
        setNeedsStatusCheck(true);
        setActionError(UNKNOWN_OUTCOME);
      } else {
        setActionError(evaluationRequestMessage(requestError));
      }
    } finally {
      if (isActive(lifecycle)) {
        actionLock.current = false;
        setSubmitting(false);
      }
    }
  }

  return <EvaluationResultView
    resultId={resultId} result={result} evaluationState={evaluationState} error={error}
    loading={!result && !error} submitting={submitting} actionError={actionError}
    handleEvaluationRequest={handleEvaluationRequest}
    checkStatus={needsStatusCheck ? checkStatus : undefined} checkingStatus={checkingStatus}
  />;
}

const DIMENSION_LABELS = {
  technicalAccuracy: "Technical accuracy",
  relevance: "Relevance",
  completeness: "Completeness",
  clarity: "Clarity",
  specificity: "Specificity",
  reflection: "Reflection",
  tradeoffs: "Tradeoffs",
};

function titleCase(value = "") {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusBadge({ status }) {
  const text = status === "pending" ? "In progress" : status === "completed" ? "Completed" : status === "failed" ? "Needs retry" : "Not started";
  const colors = status === "completed"
    ? "theme-success-surface theme-text-success"
    : status === "failed"
      ? "theme-error-surface theme-text-error"
      : "theme-accent-soft-surface theme-text-accent";
  return <span className={`inline-flex rounded-full px-3 py-1.5 text-xs font-semibold ${colors}`} aria-label={`Evaluation status: ${text}`}>{text}</span>;
}

function DataList({ title, items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <section className="rounded-xl border theme-border-subtle theme-inset-surface p-4" aria-label={title}>
      <h4 className="mb-3 text-sm font-bold theme-text-primary">{title}</h4>
      <ul className="mb-0 space-y-2 pl-5 text-sm leading-6 theme-text-secondary">
        {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
      </ul>
    </section>
  );
}

function EvaluationResultPage() {
  const { resultId } = useParams();
  const navigate = useNavigate();
  const [resultRecord, setResultRecord] = useState(null);
  const [evaluationRecord, setEvaluationRecord] = useState(null);
  const [actionErrorRecord, setActionErrorRecord] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  const result = resultRecord?.resultId === resultId ? resultRecord.result : null;
  const evaluationState = evaluationRecord?.resultId === resultId ? evaluationRecord.value : null;
  const actionError = actionErrorRecord?.resultId === resultId ? actionErrorRecord.message : "";
  const loading = resultRecord?.resultId !== resultId || resultRecord.loading;
  const error = resultRecord?.resultId === resultId ? resultRecord.error : "";

  useEffect(() => {
    let active = true;
    submitLock.current = false;
    async function load() {
      try {
        const [savedResult, status] = await Promise.all([
          getInterviewResult(resultId),
          getEvaluationStatus(resultId),
        ]);
        if (!active) return;
        if (!savedResult || !Array.isArray(savedResult.answers)) throw new Error("The saved result is incomplete or unavailable.");
        setResultRecord({ resultId, result: savedResult, loading: false, error: "" });
        setEvaluationRecord({ resultId, value: status });
        setActionErrorRecord({ resultId, message: "" });
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 401) {
          logoutUser();
          navigate("/login", { replace: true, state: { from: `/results/${resultId}` } });
          return;
        }
        setResultRecord({ resultId, result: null, loading: false, error: requestError.message || "This result could not be loaded." });
      }
    }
    load();
    return () => { active = false; };
  }, [navigate, resultId]);

  useEffect(() => {
    if (evaluationState?.status !== "pending") return undefined;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const status = await getEvaluationStatus(resultId);
        if (active) setEvaluationRecord({ resultId, value: status });
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 401) {
          logoutUser();
          navigate("/login", { replace: true, state: { from: `/results/${resultId}` } });
        }
        else setActionErrorRecord({ resultId, message: requestError.message || "Evaluation status could not be refreshed." });
      }
    }, STATUS_POLL_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [evaluationState?.status, navigate, resultId]);

  async function handleEvaluationRequest(retry) {
    if (submitLock.current || submitting || typeof retry !== "boolean") return;
    submitLock.current = true;
    setSubmitting(true);
    setActionErrorRecord({ resultId, message: "" });
    try {
      const response = await requestEvaluation(resultId, retry);
      setEvaluationRecord({ resultId, value: response });
    } catch (requestError) {
      if (requestError.status === 401) {
        logoutUser();
        navigate("/login", { replace: true, state: { from: `/results/${resultId}` } });
        return;
      }
      if (requestError.data?.status) setEvaluationRecord({ resultId, value: requestError.data });
      setActionErrorRecord({ resultId, message: requestError.message || "The evaluation request could not be completed." });
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return <EvaluationResultView
    resultId={resultId} result={result} evaluationState={evaluationState} error={error}
    loading={loading} submitting={submitting} actionError={actionError}
    handleEvaluationRequest={handleEvaluationRequest}
  />;
}

function EvaluationResultView({
  resultId, result, evaluationState, actionError, loading, error, submitting, handleEvaluationRequest,
  checkStatus, checkingStatus,
}) {
  if (loading) {
    return (
      <section className="mx-auto max-w-5xl space-y-4" role="status" aria-live="polite" aria-label="Loading evaluation result">
        <div className="h-36 animate-pulse rounded-2xl border theme-border theme-card-surface" />
        <div className="h-56 animate-pulse rounded-2xl border theme-border theme-card-surface" />
        <span className="sr-only">Loading saved evaluation...</span>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mx-auto max-w-3xl rounded-2xl border theme-border-error theme-error-surface p-6 text-center sm:p-8" role="alert">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.15em] theme-text-error">RESULT UNAVAILABLE</p>
        <h1 className="mb-2 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">Could not load this result</h1>
        <p className="mb-6 text-sm leading-6 theme-text-error">{error}</p>
        <Link to="/results" className="inline-flex min-h-10 items-center justify-center rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Back to results</Link>
      </section>
    );
  }

  const evaluation = evaluationState?.evaluation;
  const status = evaluationState?.status || result?.evaluationStatus || "not-requested";
  const canStart = result?.status === "completed" && status === "not-requested";
  const canRetry = status === "failed" && evaluationState?.retryAvailable === true;
  const interviewTitle = result?.interview?.title || "Mock interview session";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 sm:space-y-6">
      <header className="flex flex-col gap-4 rounded-2xl border theme-border theme-card-surface p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <Link to="/results" className="mb-3 inline-flex text-sm font-semibold theme-text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">← All results</Link>
          <p className="mb-1 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">MOCK INTERVIEW EVALUATION</p>
          <h1 className="mb-1 break-words font-[Manrope,sans-serif] text-xl font-bold theme-text-primary sm:text-2xl">{interviewTitle}</h1>
          <p className="mb-0 text-sm theme-text-secondary">{result?.totalQuestions ?? result?.answers?.length ?? 0} saved questions and answers</p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <StatusBadge status={status} />
          <Link to={`/mock-session/${encodeURIComponent(resultId)}`} className="text-sm font-semibold theme-text-secondary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">Review saved answers</Link>
        </div>
      </header>

      <section className="rounded-2xl border theme-border-highlight theme-card-surface p-5 shadow-sm sm:p-6" aria-labelledby="evaluation-status-heading">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="evaluation-status-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Evaluation status</h2>
            <p className="mb-0 text-sm leading-6 theme-text-secondary">{status === "pending" && checkStatus
              ? "The last saved status was in progress."
              : STATUS_COPY[status] || "Evaluation status is unavailable."}</p>
            {Number.isInteger(evaluationState?.attemptCount) && evaluationState.attemptCount > 0 && <p className="mb-0 mt-2 text-xs theme-text-muted">Attempt {evaluationState.attemptCount}</p>}
          </div>
          {canStart && !checkStatus && <button type="button" onClick={() => handleEvaluationRequest(false)} disabled={submitting} aria-busy={submitting} className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-60 sm:w-auto">
            {submitting && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />}
            {submitting ? "Starting evaluation..." : "Generate AI evaluation"}
          </button>}
          {canRetry && !checkStatus && <button type="button" onClick={() => handleEvaluationRequest(true)} disabled={submitting} aria-busy={submitting} className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-60 sm:w-auto">
            {submitting && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />}
            {submitting ? "Retrying evaluation..." : "Retry evaluation"}
          </button>}
          {status === "pending" && !checkStatus && <span className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border theme-border px-4 py-2 text-sm font-semibold theme-text-secondary sm:w-auto" role="status"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" />Evaluating answers...</span>}
          {status === "failed" && !canRetry && !checkStatus && <span className="text-sm theme-text-secondary">Retry limit reached for this result.</span>}
        </div>
        {actionError && <p className="mb-0 mt-4 rounded-xl border theme-border-error theme-error-surface px-4 py-3 text-sm theme-text-error" role="alert">{actionError}</p>}
        {checkStatus && <button type="button" onClick={checkStatus} disabled={checkingStatus || submitting} aria-busy={checkingStatus} className="mt-4 min-h-10 rounded-xl border theme-border px-4 py-2.5 text-sm font-semibold theme-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:opacity-60">
          {checkingStatus ? "Checking evaluation status..." : "Check evaluation status"}
        </button>}
      </section>

      {status === "completed" && evaluation && (
        <>
          <section className="grid gap-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]" aria-label="Evaluation summary">
            <article className="flex min-h-48 flex-col justify-center rounded-2xl border theme-border-highlight theme-card-surface p-5 shadow-sm sm:p-7">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">OVERALL SCORE</p>
              <p className="mb-1 font-[Manrope,sans-serif] text-5xl font-extrabold tracking-tight theme-text-primary">{typeof evaluation.overallScore === "number" ? evaluation.overallScore : "—"}<span className="ml-1 text-base font-semibold theme-text-muted">/ 100</span></p>
              <p className="mb-0 text-sm font-semibold theme-text-secondary">{evaluation.performanceRating ? titleCase(evaluation.performanceRating) : "No performance rating available"}</p>
            </article>
            <article className="rounded-2xl border theme-border theme-card-surface p-5 shadow-sm sm:p-7">
              <h2 className="mb-2 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Performance summary</h2>
              <p className="mb-4 whitespace-pre-wrap text-sm leading-7 theme-text-secondary">{evaluation.overallFeedback || "No written summary is available for this evaluation."}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                {Number.isFinite(evaluation.answeredCount) && <span className="rounded-full theme-accent-soft-surface px-3 py-1.5 font-semibold theme-text-accent">{evaluation.answeredCount} answered</span>}
                {Number.isFinite(evaluation.unansweredCount) && <span className="rounded-full theme-inset-surface px-3 py-1.5 font-semibold theme-text-secondary">{evaluation.unansweredCount} unanswered</span>}
              </div>
            </article>
          </section>

          {(evaluation.technicalKnowledgeAssessment || evaluation.communicationAssessment || evaluation.strongestAreas?.length || evaluation.weakestAreas?.length || evaluation.recommendedLearningTopics?.length) && (
            <section className="grid gap-4 md:grid-cols-2" aria-label="Evaluation feedback">
              {evaluation.technicalKnowledgeAssessment && <article className="rounded-2xl border theme-border theme-card-surface p-5"><h3 className="mb-2 text-sm font-bold theme-text-primary">Technical knowledge</h3><p className="mb-0 text-sm leading-6 theme-text-secondary">{evaluation.technicalKnowledgeAssessment}</p></article>}
              {evaluation.communicationAssessment && <article className="rounded-2xl border theme-border theme-card-surface p-5"><h3 className="mb-2 text-sm font-bold theme-text-primary">Communication</h3><p className="mb-0 text-sm leading-6 theme-text-secondary">{evaluation.communicationAssessment}</p></article>}
              <DataList title="Strongest areas" items={evaluation.strongestAreas} />
              <DataList title="Areas to strengthen" items={evaluation.weakestAreas} />
              <DataList title="Recommended learning topics" items={evaluation.recommendedLearningTopics} />
            </section>
          )}

          <section className="space-y-4" aria-labelledby="answer-assessments-heading">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">QUESTION BY QUESTION</p>
              <h2 id="answer-assessments-heading" className="mb-0 font-[Manrope,sans-serif] text-xl font-bold theme-text-primary">Answer assessments</h2>
            </div>
            {Array.isArray(evaluation.answers) && evaluation.answers.length > 0 ? evaluation.answers.map((answer, index) => (
              <article key={String(answer.question || index)} className="overflow-hidden rounded-2xl border theme-border theme-card-surface shadow-sm">
                <header className="flex flex-col gap-3 border-b theme-border-subtle p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
                  <div className="min-w-0"><p className="mb-1 text-xs font-semibold uppercase tracking-wide theme-text-muted">Question {answer.order ?? index + 1}{answer.category ? ` · ${answer.category}` : ""}</p><h3 className="mb-0 whitespace-pre-wrap font-[Manrope,sans-serif] text-base font-bold leading-7 theme-text-primary">{answer.questionText || "Question text unavailable"}</h3></div>
                  <div className="shrink-0 rounded-xl theme-accent-soft-surface px-4 py-2 text-sm font-bold theme-text-accent">{typeof answer.answerScore === "number" ? `${answer.answerScore} / 100` : answer.isUnanswered ? "Unanswered" : "Score unavailable"}</div>
                </header>
                <div className="space-y-4 p-5 sm:p-6">
                  <div className="rounded-xl border theme-border-subtle theme-inset-surface p-4"><p className="mb-1 text-xs font-semibold uppercase tracking-wide theme-text-muted">Your answer</p><p className="mb-0 whitespace-pre-wrap text-sm leading-6 theme-text-secondary">{answer.answerText?.trim() || "No answer was provided."}</p></div>
                  {Array.isArray(answer.dimensions) && answer.dimensions.length > 0 && <div><h4 className="mb-3 text-sm font-bold theme-text-primary">Assessment criteria</h4><div className="grid gap-3 sm:grid-cols-2">{answer.dimensions.map((dimension, dimensionIndex) => <div key={`${dimension.key}-${dimensionIndex}`} className="rounded-xl border theme-border-subtle theme-inset-surface p-4"><div className="mb-2 flex items-center justify-between gap-3"><span className="text-sm font-semibold theme-text-primary">{DIMENSION_LABELS[dimension.key] || titleCase(dimension.key)}</span><span className="text-sm font-bold theme-text-accent">{typeof dimension.score === "number" ? `${dimension.score}/100` : "—"}</span></div>{dimension.rationale && <p className="mb-0 text-xs leading-5 theme-text-secondary">{dimension.rationale}</p>}</div>)}</div></div>}
                  {(answer.strengths?.length || answer.weaknesses?.length || answer.missingConcepts?.length || answer.improvementSuggestions?.length) ? <div className="grid gap-3 md:grid-cols-2"><DataList title="Strengths" items={answer.strengths} /><DataList title="Areas to improve" items={answer.weaknesses} /><DataList title="Concepts to revisit" items={answer.missingConcepts} /><DataList title="Suggestions" items={answer.improvementSuggestions} /></div> : null}
                  {answer.suggestedImprovedAnswer && <details className="rounded-xl border theme-border-subtle theme-inset-surface p-4"><summary className="cursor-pointer text-sm font-semibold theme-text-accent focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">View suggested answer</summary><p className="mb-0 mt-3 whitespace-pre-wrap text-sm leading-6 theme-text-secondary">{answer.suggestedImprovedAnswer}</p></details>}
                </div>
              </article>
            )) : <p className="mb-0 rounded-xl border theme-border theme-card-surface p-5 text-sm theme-text-secondary">Detailed question assessments are not available for this evaluation.</p>}
          </section>
        </>
      )}

      {status === "completed" && !evaluation && <p className="rounded-xl border theme-border theme-card-surface p-5 text-sm theme-text-secondary" role="status">This saved evaluation does not include a detailed assessment payload.</p>}
      {result?.status !== "completed" && <p className="rounded-xl border theme-border theme-card-surface p-5 text-sm theme-text-secondary" role="status">This session is still in progress. Complete it before requesting an evaluation.</p>}
    </main>
  );
}

export default EvaluationResultPage;
