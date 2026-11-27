import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import InterviewPracticeStatusBadge from "../components/InterviewPracticeStatusBadge.jsx";
import { getInterviewById } from "../services/interviewService.js";
import { createQuestion, deleteQuestion, generateInterviewQuestions, getQuestions, updateQuestion } from "../services/questionService.js";
import { createMockSession, findInProgressMockSession } from "../services/mockSessionService.js";
import { AuthenticatedRequestError } from "../services/authenticatedRequest.js";

const blankQuestionForm = { questionText: "", category: "", difficulty: "Beginner", order: "1", expectedAnswer: "" };
const terminalCategories = new Set(["unauthorized", "stale-session", "cancelled", "missing-capability", "invalid-capability"]);
const generationMessages = {
  400: "Check question generation preferences.",
  404: "Interview unavailable.",
  429: "AI service rate limit reached.",
  502: "AI question generation could not be completed.",
  503: "AI question service temporarily unavailable.",
  504: "AI question request timed out.",
};

function isTerminated(error) {
  return error?.status === 401 || terminalCategories.has(error?.category);
}

function safeErrorMessage(error, fallback, messages = {}) {
  if (error?.status === 403) return "Permission denied for this operation.";
  return messages[error?.status] || fallback;
}

function isUncertainWrite(error) {
  return error?.status >= 500 || ["network-error", "request-error", "body-read-error", "malformed-response"].includes(error?.category);
}

const difficulties = ["Beginner", "Intermediate", "Advanced"];

function formatDate(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function questionMatchesGenerated(savedQuestion, generatedQuestion) {
  return savedQuestion.questionText?.trim() === generatedQuestion.questionText?.trim() &&
    savedQuestion.category?.trim() === generatedQuestion.category?.trim() &&
    savedQuestion.difficulty === generatedQuestion.difficulty &&
    (savedQuestion.expectedAnswer || "").trim() === (generatedQuestion.expectedAnswer || "").trim();
}

function DetailItem({ label, children }) {
  return (
    <div className="min-w-0 rounded-xl border theme-border-subtle theme-inset-surface p-4">
      <dt className="mb-1.5 text-xs font-semibold uppercase tracking-wide theme-text-secondary">{label}</dt>
      <dd className="mb-0 break-words text-sm font-semibold theme-text-primary">{children}</dd>
    </div>
  );
}

function canUseCapability(credentials) {
  if (!credentials) return true;
  const { capability } = credentials;
  try {
    return capability !== null && typeof capability === "object" &&
      typeof capability.fetch === "function" && capability.isCurrent() === true;
  } catch {
    return false;
  }
}

function lookupSession(interviewId, credentials) {
  if (!canUseCapability(credentials)) throw new AuthenticatedRequestError("stale-session");
  return credentials
    ? findInProgressMockSession(interviewId, credentials)
    : findInProgressMockSession(interviewId);
}

function isMissingSession(error, credentials) {
  return error?.status === 404 && (credentials
    ? error.category === "http-error" && error.data?.errorCode === "no_in_progress_session"
    : /no in-progress session/i.test(error.message));
}

function useMockInterview(interviewId, navigate, credentials, cancelOnUnmount = false) {
  const lifecycleRef = useRef(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      lifecycleRef.current = null;
      controller.abort();
    };
  }, [interviewId]);

  const [inProgressSession, setInProgressSession] = useState(null);
  const [sessionLookupLoading, setSessionLookupLoading] = useState(Boolean(interviewId));
  const [sessionActionLoading, setSessionActionLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const sessionActionInProgress = useRef(false);

  useEffect(() => {
    let active = true;
    const lifecycle = lifecycleRef.current;
    const isActive = () => active && (!credentials || lifecycleRef.current === lifecycle);
    const options = cancelOnUnmount && lifecycle ? { ...credentials, signal: lifecycle.signal } : credentials;

    async function checkInProgressSession() {
      try {
        const session = await lookupSession(interviewId, options);
        if (isActive() && canUseCapability(credentials)) setInProgressSession(session);
      } catch (requestError) {
        if (!isActive()) return;
        if (!canUseCapability(credentials) && requestError.category !== "stale-session") return;
        if (isMissingSession(requestError, credentials)) return;
        const message = requestError.message || "Unable to check for an in-progress mock interview.";
        if (!credentials && (requestError.status === 401 || /session is missing|authentication|token|access denied|sign in/i.test(message))) {
          navigate("/login", { replace: true });
          return;
        }
        setSessionError(message);
      } finally {
        if (isActive()) setSessionLookupLoading(false);
      }
    }

    if (interviewId) checkInProgressSession();

    return () => { active = false; };
  }, [interviewId, navigate, credentials, cancelOnUnmount]);

  const handleStartOrResumeMockInterview = async () => {
    if (sessionActionInProgress.current || !interviewId) return;
    const lifecycle = lifecycleRef.current;
    const isActive = () => !credentials || (lifecycle !== null && lifecycleRef.current === lifecycle);
    const isCurrent = () => isActive() && canUseCapability(credentials);
    if (!isCurrent()) return;
    const options = cancelOnUnmount ? { ...credentials, signal: lifecycle.signal } : credentials;
    sessionActionInProgress.current = true;
    setSessionActionLoading(true);
    setSessionError("");

    try {
      let session;
      let missingSession = false;
      try {
        session = await lookupSession(interviewId, options);
      } catch (lookupError) {
        if (!isMissingSession(lookupError, credentials)) throw lookupError;
        missingSession = true;
      }

      if (!isCurrent()) return;
      if (missingSession || (!credentials && !session)) {
        session = credentials
          ? await createMockSession(interviewId, options)
          : await createMockSession(interviewId);
      }
      if (!isCurrent()) return;
      if (!session?._id) throw new Error("The mock interview session could not be opened. Please try again.");

      setInProgressSession(session.status === "in-progress" ? session : null);
      navigate(`/mock-session/${encodeURIComponent(session._id)}`, {
        state: { interviewId },
      });
    } catch (requestError) {
      if (!isCurrent()) return;
      const message = requestError.message || "Unable to start the mock interview. Please try again.";
      if (!credentials && (requestError.status === 401 || /session is missing|authentication|token|access denied|sign in/i.test(message))) {
        navigate("/login", { replace: true });
        return;
      }
      setSessionError(message);
    } finally {
      if (isActive()) {
        sessionActionInProgress.current = false;
        setSessionActionLoading(false);
      }
    }
  };

  return { inProgressSession, sessionLookupLoading, sessionActionLoading, sessionError, handleStartOrResumeMockInterview };
}

function MockInterviewControls({
  inProgressSession,
  sessionLookupLoading,
  sessionActionLoading,
  sessionError,
  handleStartOrResumeMockInterview,
  questionsLoading,
  hasQuestions,
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border theme-border-highlight theme-card-surface p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6" aria-labelledby="mock-interview-heading">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] theme-text-accent">MOCK INTERVIEW</p>
        <h3 id="mock-interview-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Practice your interview</h3>
        <p className="mb-0 text-sm leading-6 theme-text-secondary">Start a timed practice session with the questions saved for this interview.</p>
      </div>
      <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:min-w-52">
        {inProgressSession ? (
          <button type="button" onClick={handleStartOrResumeMockInterview} disabled={sessionActionLoading || sessionLookupLoading} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-70">
            {sessionActionLoading ? <><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />Opening...</> : "Resume Mock Interview"}
          </button>
        ) : (
          <button type="button" onClick={handleStartOrResumeMockInterview} disabled={sessionActionLoading || sessionLookupLoading || questionsLoading || !hasQuestions} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-70">
            {sessionActionLoading || sessionLookupLoading ? <><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />{sessionActionLoading ? "Opening..." : "Checking sessions..."}</> : "Start Mock Interview"}
          </button>
        )}
        {!questionsLoading && !hasQuestions && <p className="mb-0 text-center text-xs theme-text-muted">Add at least one question to start.</p>}
      </div>
      {sessionError && <p className="mb-0 w-full rounded-xl border theme-border-error theme-error-surface px-4 py-3 text-sm theme-text-error sm:basis-full" role="alert">{sessionError}</p>}
    </section>
  );
}

// The protected interview route supplies question availability from its own authenticated data.
export function CapabilityBoundMockInterviewControls({ capability, questionsLoading, hasQuestions }) {
  const { interviewId } = useParams();
  const [credentials] = useState(() => ({ capability }));
  if (!Object.is(credentials.capability, capability)) {
    return <p role="alert">The authentication session for this interview changed.</p>;
  }
  return (
    <BoundMockInterviewLifecycle
      key={interviewId}
      interviewId={interviewId}
      credentials={credentials}
      questionsLoading={questionsLoading}
      hasQuestions={hasQuestions}
    />
  );
}

function BoundMockInterviewLifecycle({ interviewId, credentials, questionsLoading, hasQuestions, cancelOnUnmount }) {
  const navigate = useNavigate();
  const practice = useMockInterview(interviewId, navigate, credentials, cancelOnUnmount);
  return <MockInterviewControls {...practice} questionsLoading={questionsLoading} hasQuestions={hasQuestions} />;
}

function InterviewDetailsPage() {
  return <InterviewDetailsRoute />;
}

export function CapabilityBoundInterviewDetailsPage({ capability }) {
  const [credentials] = useState(() => ({ capability }));
  if (credentials.capability !== capability || !canUseCapability(credentials)) {
    return <p role="alert">The authentication session for this interview is unavailable.</p>;
  }
  return <InterviewDetailsRoute credentials={credentials} />;
}

function InterviewDetailsRoute({ credentials }) {
  const { interviewId } = useParams();
  const [generationCount, setGenerationCount] = useState("5");
  const [generationCategory, setGenerationCategory] = useState("Technical");
  const [customCategory, setCustomCategory] = useState("");
  const generationPreferences = {
    generationCount, setGenerationCount, generationCategory, setGenerationCategory, customCategory, setCustomCategory,
  };
  return <InterviewDetailsLifecycle key={interviewId} interviewId={interviewId} credentials={credentials} generationPreferences={generationPreferences} />;
}

function InterviewDetailsLifecycle({ interviewId, credentials, generationPreferences }) {
  const {
    generationCount, setGenerationCount, generationCategory, setGenerationCategory, customCategory, setCustomCategory,
  } = generationPreferences;
  const location = useLocation();
  const navigate = useNavigate();
  const [interview, setInterview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [questions, setQuestions] = useState([]);
  const [questionsLoading, setQuestionsLoading] = useState(Boolean(interviewId));
  const [questionsError, setQuestionsError] = useState(interviewId ? "" : "An interview ID is required to load questions.");
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [questionForm, setQuestionForm] = useState(blankQuestionForm);
  const [questionSaving, setQuestionSaving] = useState(false);
  const [questionFormError, setQuestionFormError] = useState("");
  const [notice, setNotice] = useState(location.state?.notice || "");
  const [actionError, setActionError] = useState("");
  const [deletingQuestionId, setDeletingQuestionId] = useState("");
  const [generationDifficulty, setGenerationDifficulty] = useState("");
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [generatedQuestions, setGeneratedQuestions] = useState([]);
  const [selectedGeneratedQuestions, setSelectedGeneratedQuestions] = useState(() => new Set());
  const [savedGeneratedQuestions, setSavedGeneratedQuestions] = useState(() => new Set());
  const [generatedSaveFailures, setGeneratedSaveFailures] = useState(() => new Map());
  const [savingGeneratedQuestions, setSavingGeneratedQuestions] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState({ type: "", message: "" });
  const generationInProgress = useRef(false);
  const saveInProgress = useRef(false);
  const manualWriteInProgress = useRef(false);
  const questionReadId = useRef(0);
  const lifecycleRef = useRef(null);
  const practice = useMockInterview(credentials ? undefined : interviewId, navigate, null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      lifecycleRef.current = null;
      controller.abort();
    };
  }, []);

  const isActive = useCallback((lifecycle) =>
    lifecycle !== null && lifecycleRef.current === lifecycle && canUseCapability(credentials),
  [credentials]);

  const request = useCallback(async (lifecycle, service, ...args) => {
    if (!isActive(lifecycle)) throw new AuthenticatedRequestError("cancelled");
    const result = credentials
      ? await service(...args, { capability: credentials.capability, signal: lifecycle.signal })
      : await service(...args);
    if (!isActive(lifecycle)) throw new AuthenticatedRequestError("cancelled");
    return result;
  }, [credentials, isActive]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;

    async function loadInterview() {
      try {
        const result = await request(lifecycle, getInterviewById, interviewId);
        if (!isActive(lifecycle)) return;
        if (credentials && result._id !== interviewId) {
          throw new AuthenticatedRequestError("malformed-response");
        }
        setInterview(result);
      } catch (requestError) {
        if (!isActive(lifecycle)) return;
        const fallback = "Unable to load this interview. Please try again.";
        if (credentials) {
          if (!isTerminated(requestError)) {
            setError(safeErrorMessage(requestError, fallback, { 400: "This interview ID is invalid.", 404: "Interview unavailable." }));
          }
          return;
        }
        const message = requestError.message || fallback;
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
        if (isActive(lifecycle)) setLoading(false);
      }
    }

    loadInterview();
  }, [credentials, interviewId, isActive, navigate, request]);

  const readQuestions = useCallback(async (lifecycle) => {
    const result = await request(lifecycle, getQuestions, interviewId);
    if (credentials && result.some((question) => question.interview !== interviewId)) {
      throw new AuthenticatedRequestError("malformed-response");
    }
    return result;
  }, [credentials, interviewId, request]);

  const loadQuestionList = useCallback(async (lifecycle, {
    fallback = "Unable to load questions. Please try again.",
    onError = setQuestionsError,
    redirectLegacy = true,
  } = {}) => {
    const readId = ++questionReadId.current;
    const acceptsResult = () => isActive(lifecycle) && readId === questionReadId.current;
    try {
      const result = await readQuestions(lifecycle);
      if (!acceptsResult()) return { terminated: true };
      setQuestions(result);
      return { result };
    } catch (error) {
      if (!acceptsResult() || (credentials && isTerminated(error))) return { terminated: true };
      const message = credentials ? safeErrorMessage(error, fallback) : error.message || fallback;
      if (!credentials && redirectLegacy && /session is missing|authentication|token|access denied|sign in/i.test(message)) {
        navigate("/login", { replace: true });
        return { terminated: true };
      }
      onError(message);
      return { error: message };
    } finally {
      if (acceptsResult()) setQuestionsLoading(false);
    }
  }, [credentials, isActive, navigate, readQuestions]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    if (interviewId) loadQuestionList(lifecycle);
  }, [interviewId, loadQuestionList]);

  const reloadQuestionList = async (lifecycle, options) => {
    if (!isActive(lifecycle)) return { terminated: true };
    setQuestionsLoading(true);
    setQuestionsError("");
    return loadQuestionList(lifecycle, options);
  };

  const sortedQuestions = [...questions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const selectedDifficulty = generationDifficulty || interview?.difficulty || "Intermediate";
  const selectableGeneratedQuestionIndices = generatedQuestions
    .map((_, index) => index)
    .filter((index) => !savedGeneratedQuestions.has(index));
  const selectedGeneratedQuestionCount = [...selectedGeneratedQuestions]
    .filter((index) => !savedGeneratedQuestions.has(index)).length;
  const allGeneratedQuestionsSelected = selectableGeneratedQuestionIndices.length > 0 &&
    selectableGeneratedQuestionIndices.every((index) => selectedGeneratedQuestions.has(index));

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

    const lifecycle = lifecycleRef.current;
    if (!isActive(lifecycle) || manualWriteInProgress.current || saveInProgress.current) return;
    const questionId = editingQuestion?._id;
    const fields = {
      questionText, category, difficulty: questionForm.difficulty, order,
      expectedAnswer: questionForm.expectedAnswer.trim(),
    };

    manualWriteInProgress.current = true;
    setQuestionSaving(true);
    setNotice("");
    try {
      if (editingQuestion) {
        await request(lifecycle, updateQuestion, questionId, fields);
      } else {
        await request(lifecycle, createQuestion, { ...fields, interview: interviewId });
      }
      if (!isActive(lifecycle)) return;
      setQuestionModalOpen(false);
      setEditingQuestion(null);
      setQuestionForm(blankQuestionForm);
      setNotice(editingQuestion ? "Question updated successfully." : "Question created successfully.");
      await reloadQuestionList(lifecycle, {
        fallback: "Question was saved, but the list could not be refreshed.",
      });
    } catch (requestError) {
      if (!isActive(lifecycle) || (credentials && isTerminated(requestError))) return;
      const fallback = "Unable to create this question. Please try again.";
      if (credentials) {
        if (isUncertainWrite(requestError)) {
          setQuestionModalOpen(false);
          await recoverQuestionWrite(lifecycle);
        } else {
          setQuestionFormError(safeErrorMessage(requestError, fallback));
        }
        return;
      }
      const message = requestError.message || fallback;
      if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
        navigate("/login", { replace: true });
        return;
      }
      setQuestionFormError(message);
    } finally {
      if (isActive(lifecycle)) {
        manualWriteInProgress.current = false;
        setQuestionSaving(false);
      }
    }
  };

  const recoverQuestionWrite = async (lifecycle) => {
    const { terminated } = await reloadQuestionList(lifecycle, {
      fallback: "The question list could not be refreshed.",
    });
    if (isActive(lifecycle) && !terminated) {
      setActionError("The result of the question change could not be confirmed. Review the question list before making another change.");
    }
  };

  const handleDeleteQuestion = async (question) => {
    const lifecycle = lifecycleRef.current;
    if (!isActive(lifecycle) || manualWriteInProgress.current || saveInProgress.current) return;
    const questionId = question._id;
    const confirmed = window.confirm(`Delete ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ${question.questionText}ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â? This action cannot be undone.`);
    if (!confirmed || !isActive(lifecycle)) return;

    manualWriteInProgress.current = true;
    setDeletingQuestionId(questionId);
    setNotice("");
    setActionError("");
    try {
      await request(lifecycle, deleteQuestion, questionId);
      if (!isActive(lifecycle)) return;
      setNotice("Question deleted successfully.");
      await reloadQuestionList(lifecycle, {
        fallback: "Question was deleted, but the list could not be refreshed.",
        onError: credentials ? setQuestionsError : setActionError,
      });
    } catch (requestError) {
      if (!isActive(lifecycle) || (credentials && isTerminated(requestError))) return;
      const fallback = "Unable to delete this question. Please try again.";
      if (credentials) {
        if (isUncertainWrite(requestError)) await recoverQuestionWrite(lifecycle);
        else setActionError(safeErrorMessage(requestError, fallback));
        return;
      }
      const message = requestError.message || fallback;
      if (/session is missing|authentication|token|access denied|sign in/i.test(message)) {
        navigate("/login", { replace: true });
        return;
      }
      setActionError(message);
    } finally {
      if (isActive(lifecycle)) {
        manualWriteInProgress.current = false;
        setDeletingQuestionId("");
      }
    }
  };

  const handleGenerateQuestions = async () => {
    const lifecycle = lifecycleRef.current;
    if (!isActive(lifecycle) || generationInProgress.current || saveInProgress.current) return;

    const count = Number(generationCount);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      setGenerationError("Choose a whole number of questions from 1 to 10.");
      return;
    }
    if (!difficulties.includes(selectedDifficulty)) {
      setGenerationError("Choose a valid difficulty.");
      return;
    }

    const category = generationCategory === "Custom" ? customCategory.trim() : generationCategory;
    if (!category || category.length > 60) {
      setGenerationError("Enter a custom category with 1 to 60 characters.");
      return;
    }

    generationInProgress.current = true;
    setGeneratingQuestions(true);
    setGenerationError("");
    try {
      const result = await request(lifecycle, generateInterviewQuestions, interviewId, {
        count,
        difficulty: selectedDifficulty,
        category,
      });
      if (!isActive(lifecycle)) return;
      const validResult = result.length === count && result.every((question) =>
        question &&
        typeof question.questionText === "string" && question.questionText.trim() &&
        typeof question.category === "string" && question.category.trim() &&
        difficulties.includes(question.difficulty) &&
        typeof question.expectedAnswer === "string" && question.expectedAnswer.trim()
      );
      if (!validResult) {
        throw new Error("The generated questions were incomplete. Please try again.");
      }

      setGeneratedQuestions(result);
      setSelectedGeneratedQuestions(new Set());
      setSavedGeneratedQuestions(new Set());
      setGeneratedSaveFailures(new Map());
      setSaveFeedback({ type: "", message: "" });
    } catch (requestError) {
      if (!isActive(lifecycle)) return;
      if (credentials) {
        if (!isTerminated(requestError)) {
          setGenerationError(safeErrorMessage(requestError, "Unable to generate questions. Please try again.", generationMessages));
        }
        return;
      }
      const message = requestError.message || "Unable to generate questions. Please try again.";
      if (requestError.status === 401 || /session is missing|authentication token/i.test(message)) {
        setGenerationError("Your session has expired. Please sign in again.");
        navigate("/login", { replace: true });
        return;
      }
      setGenerationError(message);
    } finally {
      if (isActive(lifecycle)) {
        generationInProgress.current = false;
        setGeneratingQuestions(false);
      }
    }
  };

  const handleSaveSelectedQuestions = async () => {
    const lifecycle = lifecycleRef.current;
    if (!isActive(lifecycle) || saveInProgress.current || manualWriteInProgress.current || generationInProgress.current) return;

    const selectedIndices = [...selectedGeneratedQuestions]
      .filter((index) => !savedGeneratedQuestions.has(index))
      .sort((a, b) => a - b);
    if (selectedIndices.length === 0) {
      setSaveFeedback({ type: "error", message: "No questions are selected to save." });
      return;
    }

    const preview = generatedQuestions;
    saveInProgress.current = true;
    setSavingGeneratedQuestions(true);
    setSaveFeedback({ type: "", message: "" });
    setGeneratedSaveFailures(new Map());

    try {
      const existingQuestions = await readQuestions(lifecycle);
      if (!isActive(lifecycle)) return;

      let nextOrder = existingQuestions.reduce((highest, question) => {
        const order = Number(question.order);
        return Number.isFinite(order) ? Math.max(highest, Math.floor(order)) : highest;
      }, 0) + 1;
      const successfulIndices = [];
      const failedItems = [];
      let unauthorized = false;
      let orderStateUncertain = false;

      for (const index of selectedIndices) {
        const generatedQuestion = preview[index];
        if (generatedQuestion && existingQuestions.some((question) => questionMatchesGenerated(question, generatedQuestion))) {
          successfulIndices.push(index);
        }
      }

      for (let position = 0; position < selectedIndices.length; position += 1) {
        if (!isActive(lifecycle)) return;
        const index = selectedIndices[position];
        if (successfulIndices.includes(index)) continue;
        const question = preview[index];
        if (!question) {
          failedItems.push({ index, message: "This preview question is no longer available." });
          continue;
        }

        if (unauthorized || orderStateUncertain) {
          failedItems.push({
            index,
            message: unauthorized
              ? "Your session expired before this question could be saved."
              : "A previous save could not be verified, so this question was held to avoid an order conflict. Retry after refreshing.",
          });
          continue;
        }

        try {
          await request(lifecycle, createQuestion, {
            interview: interviewId,
            questionText: question.questionText,
            category: question.category,
            difficulty: question.difficulty,
            expectedAnswer: question.expectedAnswer,
            order: nextOrder,
          });
          if (!isActive(lifecycle)) return;
          successfulIndices.push(index);
          nextOrder += 1;
        } catch (saveError) {
          if (!isActive(lifecycle) || (credentials && isTerminated(saveError))) return;
          const fallback = "This question could not be saved.";
          const message = credentials ? safeErrorMessage(saveError, fallback) : saveError.message || fallback;
          if (credentials && !isUncertainWrite(saveError)) {
            failedItems.push({ index, message });
            continue;
          }

          let confirmedSaved = false;
          try {
            const currentQuestions = await readQuestions(lifecycle);
            if (!isActive(lifecycle)) return;
            confirmedSaved = currentQuestions.some((savedQuestion) => questionMatchesGenerated(savedQuestion, question));
            if (confirmedSaved) {
              successfulIndices.push(index);
              nextOrder = currentQuestions.reduce((highest, currentQuestion) => {
                const order = Number(currentQuestion.order);
                return Number.isFinite(order) ? Math.max(highest, Math.floor(order)) : highest;
              }, 0) + 1;
            }
          } catch (readError) {
            if (!isActive(lifecycle) || (credentials && isTerminated(readError))) return;
            orderStateUncertain = true;
          }
          if (credentials && !confirmedSaved) orderStateUncertain = true;
          if (!confirmedSaved) failedItems.push({ index, message });
          if (!credentials && (saveError.status === 401 || /session is missing|authentication token/i.test(message))) {
            unauthorized = true;
          }
        }
      }

      if (!isActive(lifecycle)) return;
      let refreshError = "";
      if (successfulIndices.length > 0 || failedItems.length > 0) {
        const refresh = await reloadQuestionList(lifecycle, {
          fallback: "The saved questions could not be refreshed.",
          redirectLegacy: false,
        });
        if (!isActive(lifecycle) || refresh.terminated) return;
        refreshError = refresh.error || "";
        const refreshedQuestions = refresh.result;
        if (refreshedQuestions) {
          for (let position = failedItems.length - 1; position >= 0; position -= 1) {
            const failed = failedItems[position];
            const attempted = preview[failed.index];
            const alreadyPresent = attempted && refreshedQuestions.some((savedQuestion) =>
              questionMatchesGenerated(savedQuestion, attempted)
            );
            if (alreadyPresent) {
              successfulIndices.push(failed.index);
              failedItems.splice(position, 1);
            }
          }
        }
      }

      if (!isActive(lifecycle)) return;
      if (successfulIndices.length > 0) {
        setSavedGeneratedQuestions((current) => new Set([...current, ...successfulIndices]));
        setSelectedGeneratedQuestions((current) => new Set(
          [...current].filter((index) => !successfulIndices.includes(index))
        ));
      }
      setGeneratedSaveFailures(new Map(failedItems.map(({ index, message }) => [index, message])));

      if (unauthorized) {
        setSaveFeedback({ type: "error", message: "Your session expired. Sign in again to retry the unsaved questions." });
        navigate("/login", { replace: true });
      } else if (failedItems.length > 0) {
        const refreshMessage = refreshError ? ` The question list could not be refreshed: ${refreshError}` : "";
        setSaveFeedback({
          type: "error",
          message: `${successfulIndices.length} saved; ${failedItems.length} could not be saved. Failed questions remain selected so you can retry.${refreshMessage}`,
        });
      } else {
        setSaveFeedback({
          type: refreshError ? "error" : "success",
          message: refreshError
            ? `All selected questions were saved, but the question list could not be refreshed: ${refreshError}`
            : "All selected questions saved successfully.",
        });
      }
    } catch (error) {
      if (!isActive(lifecycle)) return;
      if (credentials) {
        if (!isTerminated(error)) {
          setSaveFeedback({ type: "error", message: safeErrorMessage(error, "Unable to load the question list before saving. Try again.") });
        }
        return;
      }
      const message = error.message || "Saving failed. Check your connection and try again.";
      if (error.status === 401 || /session is missing|authentication token/i.test(message)) {
        setSaveFeedback({ type: "error", message: "Your session expired. Sign in again to save the selected questions." });
        navigate("/login", { replace: true });
      } else {
        setSaveFeedback({ type: "error", message: `Saving failed. No questions were saved. ${message}` });
      }
    } finally {
      if (isActive(lifecycle)) {
        saveInProgress.current = false;
        setSavingGeneratedQuestions(false);
      }
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
          Loading interview detailsÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦
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
          <DetailItem label="Practice status"><InterviewPracticeStatusBadge practiceStatus={interview?.practiceStatus} /></DetailItem>
          <DetailItem label="Created date"><time dateTime={interview?.createdAt || undefined}>{formatDate(interview?.createdAt)}</time></DetailItem>
          {interview._id && <DetailItem label="Interview ID">{interview._id}</DetailItem>}
        </dl>
      </section>
      ) : null}

      {interview && (
        credentials
          ? <BoundMockInterviewLifecycle interviewId={interviewId} credentials={credentials} cancelOnUnmount questionsLoading={questionsLoading} hasQuestions={!questionsError && questions.length > 0} />
          : <MockInterviewControls {...practice} questionsLoading={questionsLoading} hasQuestions={questions.length > 0} />
      )}

      <section className="relative overflow-hidden rounded-2xl border theme-border-highlight theme-card-surface p-5 shadow-sm sm:p-6" aria-labelledby="ai-generator-heading">
        <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative">
          <div className="mb-6 flex flex-col gap-4 border-b theme-border-subtle pb-5 sm:flex-row sm:items-center">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl theme-accent-soft-surface theme-text-accent ring-1 ring-emerald-400/20">
              <svg aria-hidden="true" className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v2m0 14v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M3 12h2m14 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="mb-1 text-xs font-bold uppercase tracking-[0.15em] theme-text-accent">PERSONALIZED PRACTICE</p>
              <h3 id="ai-generator-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">AI Question Generator</h3>
              <p className="mb-0 text-sm leading-6 theme-text-secondary">Generate personalized interview questions based on your skills, experience and target role.</p>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <label className="block min-w-0">
              <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Number of Questions</span>
              <input
                type="number"
                min="1"
                max="10"
                step="1"
                value={generationCount}
                onChange={(event) => setGenerationCount(event.target.value)}
                className="h-11 w-full min-w-0 rounded-xl border theme-border px-3 text-sm outline-none transition theme-input-focus focus:ring-2"
              />
              <span className="mt-1.5 block text-xs theme-text-muted">Choose between 1 and 10 questions.</span>
            </label>

            <label className="block min-w-0">
              <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Difficulty</span>
              <select
                value={selectedDifficulty}
                onChange={(event) => setGenerationDifficulty(event.target.value)}
                className="h-11 w-full min-w-0 rounded-xl border theme-border px-3 text-sm outline-none transition theme-input-focus focus:ring-2"
              >
                {difficulties.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
              </select>
              <span className="mt-1.5 block text-xs theme-text-muted">Starts with this interviewÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢s difficulty.</span>
            </label>

            <div className="min-w-0 sm:col-span-2 xl:col-span-1">
              <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-semibold theme-text-primary">Question Category</span>
                <select
                  value={generationCategory}
                  onChange={(event) => setGenerationCategory(event.target.value)}
                  className="h-11 w-full min-w-0 rounded-xl border theme-border px-3 text-sm outline-none transition theme-input-focus focus:ring-2"
                >
                  <option value="Technical">Technical</option>
                  <option value="Behavioral">Behavioral</option>
                  <option value="Problem Solving">Problem Solving</option>
                  <option value="Scenario Based">Scenario Based</option>
                  <option value="Custom">Custom</option>
                </select>
              </label>
              {generationCategory === "Custom" && (
                <label className="mt-3 block min-w-0">
                  <span className="sr-only">Custom question category</span>
                  <input
                    type="text"
                    value={customCategory}
                    onChange={(event) => setCustomCategory(event.target.value)}
                    maxLength={60}
                    placeholder="Enter a category (up to 60 characters)"
                    className="h-11 w-full min-w-0 rounded-xl border theme-border px-3 text-sm outline-none transition placeholder:theme-text-muted theme-input-focus focus:ring-2"
                  />
                </label>
              )}
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t theme-border-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="mb-0 max-w-xl text-xs leading-5 theme-text-muted">Questions will be tailored to this interview and your candidate profile.</p>
            <button type="button" onClick={handleGenerateQuestions} disabled={generatingQuestions || savingGeneratedQuestions} className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold shadow-sm theme-shadow-green transition hover:-translate-y-0.5 theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70 sm:w-auto">
              {generatingQuestions ? (
                <><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />Generating...</>
              ) : (
                <><svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></svg>Generate Questions with AI</>
              )}
            </button>
          </div>
          {generationError && <p className="mb-0 mt-4 rounded-xl border theme-border-error theme-error-surface px-4 py-3 text-sm theme-text-error" role="alert">{generationError}</p>}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border theme-border theme-card-surface shadow-sm" aria-labelledby="generated-preview-heading">
        <div className="flex flex-col gap-4 border-b theme-border-subtle px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] theme-text-accent">REVIEW BEFORE SAVING</p>
            <h3 id="generated-preview-heading" className="mb-1 font-[Manrope,sans-serif] text-lg font-bold theme-text-primary">Generated Questions Preview</h3>
            <p className="mb-0 text-sm theme-text-secondary">Review the questions and save only the ones you want to add to this interview.</p>
          </div>
          {generatedQuestions.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="rounded-full theme-accent-soft-surface px-3 py-1.5 text-xs font-semibold theme-text-accent" aria-live="polite">
                {selectedGeneratedQuestionCount} selected
              </span>
              {savedGeneratedQuestions.size > 0 && <span className="rounded-full theme-success-surface px-3 py-1.5 text-xs font-semibold theme-text-success">{savedGeneratedQuestions.size} saved</span>}
              <button type="button" disabled={savingGeneratedQuestions || selectableGeneratedQuestionIndices.length === 0} onClick={() => setSelectedGeneratedQuestions(allGeneratedQuestionsSelected ? new Set() : new Set(selectableGeneratedQuestionIndices))} className="min-h-9 rounded-lg border theme-border px-3 py-2 text-xs font-semibold theme-text-primary transition theme-hover-border theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-not-allowed disabled:opacity-60">
                {allGeneratedQuestionsSelected ? "Deselect all" : "Select all"}
              </button>
              {selectedGeneratedQuestionCount > 0 && (
                <button type="button" disabled={savingGeneratedQuestions} onClick={() => setSelectedGeneratedQuestions(new Set())} className="min-h-9 rounded-lg border theme-border px-3 py-2 text-xs font-semibold theme-text-secondary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-not-allowed disabled:opacity-60">
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>

        {generatingQuestions && (
          <div className="flex items-center gap-3 border-b theme-border-subtle px-5 py-4 text-sm theme-text-secondary" role="status" aria-live="polite">
            <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 theme-border-highlight theme-spinner-active" />
            Generating a tailored question set...
          </div>
        )}

        {generatedQuestions.length === 0 ? (
          <div className="px-5 py-9 text-center sm:px-8">
            <p className="mb-1 text-sm font-semibold theme-text-primary" role="status">No generated questions to preview yet.</p>
            <p className="mb-0 text-sm theme-text-secondary">Set your preferences above and generate a question set to review it here.</p>
          </div>
        ) : (
          <div className="space-y-4 p-4 sm:p-6">
            {generatedQuestions.map((question, index) => {
              const saved = savedGeneratedQuestions.has(index);
              const selected = selectedGeneratedQuestions.has(index);
              return (
                <article key={`${index}-${question.questionText}`} className={`min-w-0 rounded-xl border theme-inset-surface p-4 transition sm:p-5 ${selected || saved ? "border-emerald-400/60 shadow-[0_0_0_1px_rgba(52,211,153,0.12)]" : "theme-border-subtle"}`}>
                  <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="rounded-full theme-accent-soft-surface px-2.5 py-1 text-xs font-semibold theme-text-accent">Question {index + 1}</span>
                        <span className="rounded-full theme-card-surface px-2.5 py-1 text-xs font-medium theme-text-secondary">{question.category}</span>
                        <span className="rounded-full theme-card-surface px-2.5 py-1 text-xs font-medium theme-text-secondary">{question.difficulty}</span>
                        {saved && <span className="rounded-full theme-success-surface px-2.5 py-1 text-xs font-semibold theme-text-success">Saved</span>}
                      </div>
                      <h4 className="mb-0 break-words text-base font-semibold leading-7 theme-text-primary">{question.questionText}</h4>
                    </div>
                    <label className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border theme-border px-3 py-2 text-sm font-semibold theme-text-primary transition theme-hover-border theme-hover-surface focus-within:ring-2 theme-focus-ring">
                      <input
                        type="checkbox"
                        checked={selected || saved}
                        disabled={savingGeneratedQuestions || saved}
                        onChange={() => setSelectedGeneratedQuestions((current) => {
                          const next = new Set(current);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })}
                        className="h-4 w-4 accent-emerald-400"
                        aria-label={`Select generated question ${index + 1}`}
                      />
                      Select
                    </label>
                  </div>
                  <details className="group mt-4 border-t theme-border-subtle pt-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold theme-text-accent focus-visible:outline-none focus-visible:ring-2 theme-focus-ring">
                      <span>Expected answer</span>
                      <svg aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                    </summary>
                    <p className="mb-0 mt-3 whitespace-pre-wrap break-words text-sm leading-6 theme-text-secondary">{question.expectedAnswer}</p>
                  </details>
                  {generatedSaveFailures.has(index) && (
                    <p className="mb-0 mt-3 rounded-lg border theme-border-error theme-error-surface px-3 py-2 text-sm theme-text-error" role="alert">
                      Save failed: {generatedSaveFailures.get(index)}
                    </p>
                  )}
                </article>
              );
            })}
            {selectedGeneratedQuestionCount === 0 && selectableGeneratedQuestionIndices.length > 0 && (
              <p className="mb-0 rounded-lg border theme-border-subtle px-4 py-3 text-sm theme-text-secondary" role="status">No questions selected. Select questions individually or use Select all.</p>
            )}
            {selectableGeneratedQuestionIndices.length === 0 && (
              <p className="mb-0 rounded-lg border theme-border-success theme-success-surface px-4 py-3 text-sm theme-text-success" role="status">All questions in this preview have been saved.</p>
            )}
            {saveFeedback.message && (
              <p className={`mb-0 rounded-xl border px-4 py-3 text-sm ${saveFeedback.type === "success" ? "theme-border-success theme-success-surface theme-text-success" : "theme-border-error theme-error-surface theme-text-error"}`} role={saveFeedback.type === "success" ? "status" : "alert"}>
                {saveFeedback.message}
              </p>
            )}
            <div className="flex flex-col gap-3 border-t theme-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="mb-0 text-xs theme-text-muted">Saved questions are added after the highest existing question order.</p>
              <button type="button" onClick={handleSaveSelectedQuestions} disabled={savingGeneratedQuestions || questionSaving || questionModalOpen || Boolean(deletingQuestionId) || selectedGeneratedQuestionCount === 0} className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-5 py-3 text-sm font-bold shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">
                {savingGeneratedQuestions ? (
                  <><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 theme-spinner-border theme-spinner-head" />Saving selected questions...</>
                ) : `Save Selected Questions (${selectedGeneratedQuestionCount})`}
              </button>
            </div>
          </div>
        )}
      </section>

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
          <button type="button" onClick={openQuestionModal} disabled={!interviewId || savingGeneratedQuestions} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl theme-primary-button px-4 py-2.5 text-sm font-semibold theme-text-primary shadow-sm theme-shadow-green transition theme-hover-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
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
            {credentials && (
              <button type="button" className="mt-3 rounded-lg border theme-border px-3 py-2 text-sm" disabled={questionSaving || Boolean(deletingQuestionId) || savingGeneratedQuestions}
                onClick={() => reloadQuestionList(lifecycleRef.current)}>
                Reload questions
              </button>
            )}
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
                      <button type="button" onClick={() => openEditQuestionModal(question)} disabled={Boolean(deletingQuestionId) || savingGeneratedQuestions} className="rounded-lg border theme-border px-3 py-1.5 text-xs font-semibold theme-text-secondary transition theme-hover-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-ring disabled:cursor-wait disabled:opacity-60">Edit</button>
                      <button type="button" onClick={() => handleDeleteQuestion(question)} disabled={Boolean(deletingQuestionId) || questionSaving || savingGeneratedQuestions} className="rounded-lg border theme-border-error px-3 py-1.5 text-xs font-semibold theme-text-error transition theme-hover-error-surface focus-visible:outline-none focus-visible:ring-2 theme-focus-error-ring disabled:cursor-wait disabled:opacity-60">
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





