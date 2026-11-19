import express from "express";
import mongoose from "mongoose";
import Interview from "../models/Interview.js";
import InterviewResult from "../models/InterviewResult.js";
import Question from "../models/Question.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { createSessionAnswerSnapshots, sessionPayload } from "../utils/mockSessionData.js";
import { evaluateInterviewSession } from "../services/aiAnswerEvaluationService.js";
import { sanitizeInterviewResult } from "../utils/interviewResultSerialization.js";

const router = express.Router();
const MAX_ANSWER_LENGTH = 20000;
const MAX_EVALUATION_ATTEMPTS = 3;
router.use(authMiddleware);

function validId(value) {
  return mongoose.isValidObjectId(value);
}

function evaluationClientPayload(result) {
  return sanitizeInterviewResult(result, { omitRelations: true });
}

function evaluationStatusPayload(result, includeResult = false) {
  const status = result.evaluationStatus || "not-requested";
  const payload = { status, attemptCount: result.evaluationAttemptCount || 0 };
  if (status === "failed") {
    payload.errorCode = result.evaluationErrorCode || "evaluation_failed";
    payload.message = "Evaluation failed. You can retry this evaluation.";
    payload.retryAvailable = (result.evaluationAttemptCount || 0) < MAX_EVALUATION_ATTEMPTS;
  }
  if (includeResult && status === "completed") payload.evaluation = evaluationClientPayload(result);
  return payload;
}

function validEvaluationSnapshots(session) {
  if (!Array.isArray(session.answers) || session.answers.length < 1 || session.answers.length > 50 || session.answers.length !== session.totalQuestions) return false;
  const ids = new Set();
  return session.answers.every((answer) => {
    const id = answer.question?._id || answer.question;
    const key = String(id);
    if (!validId(key) || ids.has(key) || typeof answer.questionText !== "string" || !answer.questionText.trim() ||
        typeof answer.category !== "string" || !answer.category.trim() ||
        !["Beginner", "Intermediate", "Advanced"].includes(answer.difficulty) ||
        typeof answer.answerText !== "string" || answer.answerText.length > MAX_ANSWER_LENGTH ||
        typeof answer.referenceAnswerSnapshot !== "string" || answer.referenceAnswerSnapshot.length > 5000) return false;
    ids.add(key);
    return true;
  });
}

router.get("/mock-sessions/:sessionId/evaluation", async (req, res) => {
  try {
    if (!validId(req.params.sessionId)) return res.status(400).json({ success: false, message: "Invalid session ID" });
    const result = await InterviewResult.findOne({ _id: req.params.sessionId, user: req.user.userId });
    if (!result) return res.status(404).json({ success: false, message: "Mock interview session not found" });
    return res.status(200).json({ success: true, ...evaluationStatusPayload(result, true) });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to retrieve evaluation" });
  }
});

router.post("/mock-sessions/:sessionId/evaluation", async (req, res) => {
  try {
    if (!validId(req.params.sessionId)) return res.status(400).json({ success: false, message: "Invalid session ID" });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "retry") ||
        Object.keys(body).some((key) => key !== "retry") || typeof body.retry !== "boolean") {
      return res.status(400).json({ success: false, message: "Request body may contain only a boolean retry field" });
    }
    const retry = body.retry === true;
    const owned = await InterviewResult.findOne({ _id: req.params.sessionId, user: req.user.userId });
    if (!owned) return res.status(404).json({ success: false, message: "Mock interview session not found" });
    if (owned.status !== "completed") return res.status(409).json({ success: false, message: "Only completed sessions can be evaluated" });
    if (!(owned.completedAt instanceof Date) || Number.isNaN(owned.completedAt.getTime())) return res.status(409).json({ success: false, message: "Session has no valid completion time" });
    if (!validEvaluationSnapshots(owned)) return res.status(400).json({ success: false, message: "Session answer snapshots are invalid" });

    const current = owned.evaluationStatus || "not-requested";
    if (current === "completed") return res.status(200).json({ success: true, ...evaluationStatusPayload(owned, true) });
    if (current === "pending") return res.status(202).json({ success: true, ...evaluationStatusPayload(owned) });
    if (current === "failed" && !retry) return res.status(409).json({ success: false, ...evaluationStatusPayload(owned) });
    if (retry && current !== "failed") return res.status(409).json({ success: false, message: "Retry is available only after a failed evaluation", ...evaluationStatusPayload(owned) });
    if ((owned.evaluationAttemptCount || 0) >= MAX_EVALUATION_ATTEMPTS) return res.status(409).json({ success: false, message: "Evaluation retry limit reached", ...evaluationStatusPayload(owned) });

    const now = new Date();
    const eligible = retry
      ? { evaluationStatus: "failed", evaluationAttemptCount: { $lt: MAX_EVALUATION_ATTEMPTS } }
      : { $or: [{ evaluationStatus: "not-requested" }, { evaluationStatus: { $exists: false } }, { evaluationStatus: null }] };
    const claimed = await InterviewResult.findOneAndUpdate(
      { _id: owned._id, user: req.user.userId, status: "completed", completedAt: { $type: "date" }, ...eligible },
      { $set: { evaluationStatus: "pending", evaluationRequestedAt: now, evaluationStartedAt: now, evaluationFailedAt: null, evaluationErrorCode: null }, $inc: { evaluationAttemptCount: 1 } },
      { returnDocument: "after", runValidators: true }
    );
    if (!claimed) {
      const latest = await InterviewResult.findOne({ _id: owned._id, user: req.user.userId });
      if (!latest) return res.status(404).json({ success: false, message: "Mock interview session not found" });
      const latestStatus = latest.evaluationStatus || "not-requested";
      if (latestStatus === "completed") return res.status(200).json({ success: true, ...evaluationStatusPayload(latest, true) });
      if (latestStatus === "pending") return res.status(202).json({ success: true, ...evaluationStatusPayload(latest) });
      return res.status(409).json({ success: false, ...evaluationStatusPayload(latest) });
    }

    const attempt = claimed.evaluationAttemptCount;
    try {
      const { persistencePayload, clientPayload } = await evaluateInterviewSession(claimed);
      if (!persistencePayload || !clientPayload || !Array.isArray(persistencePayload.answers) || !Array.isArray(clientPayload.answers)) {
        const error = new Error("invalid_output"); error.code = "invalid_output"; throw error;
      }
      const evaluatedByQuestion = new Map(persistencePayload.answers.map((answer) => [String(answer.question), answer]));
      const mergedAnswers = claimed.answers.map((answer) => {
        const evaluated = evaluatedByQuestion.get(String(answer.question));
        return evaluated ? { ...answer.toObject(), ...evaluated, question: answer.question, questionText: answer.questionText,
          referenceAnswerSnapshot: answer.referenceAnswerSnapshot, answerText: answer.answerText,
          score: answer.score, feedback: answer.feedback } : answer.toObject();
      });
      const { answers: _answers, evaluationStatus: _status, evaluationCompletedAt: _completedAt, ...summary } = persistencePayload;
      const completedAt = new Date();
      const saved = await InterviewResult.findOneAndUpdate(
        { _id: claimed._id, user: req.user.userId, evaluationStatus: "pending", evaluationAttemptCount: attempt },
        { $set: { ...summary, answers: mergedAnswers, evaluationStatus: "completed", evaluationCompletedAt: completedAt, evaluationFailedAt: null, evaluationErrorCode: null } },
        { returnDocument: "after", runValidators: true }
      );
      if (!saved) {
        const latest = await InterviewResult.findOne({ _id: claimed._id, user: req.user.userId });
        return res.status(latest?.evaluationStatus === "completed" ? 200 : 409).json({ success: Boolean(latest), ...evaluationStatusPayload(latest || {}, true) });
      }
      return res.status(200).json({ success: true, ...evaluationStatusPayload(saved, true) });
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "evaluation_failed";
      const failed = await InterviewResult.findOneAndUpdate(
        { _id: claimed._id, user: req.user.userId, evaluationStatus: "pending", evaluationAttemptCount: attempt },
        { $set: { evaluationStatus: "failed", evaluationFailedAt: new Date(), evaluationErrorCode: code } },
        { returnDocument: "after" }
      );
      if (!failed) {
        const latest = await InterviewResult.findOne({ _id: claimed._id, user: req.user.userId });
        return res.status(latest?.evaluationStatus === "completed" ? 200 : 409).json({ success: Boolean(latest), ...evaluationStatusPayload(latest || {}, true) });
      }
      return res.status(502).json({ success: false, ...evaluationStatusPayload(failed) });
    }
  } catch {
    return res.status(500).json({ success: false, message: "Failed to start evaluation" });
  }
});

// Mounted at /api. Place the static in-progress path before any broader interview paths.
router.get("/interviews/:interviewId/sessions/in-progress", async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!validId(interviewId)) {
      return res.status(400).json({ success: false, message: "Invalid interview ID" });
    }
    const interview = await Interview.findOne({ _id: interviewId, user: req.user.userId }).select("_id");
    if (!interview) return res.status(404).json({ success: false, message: "Interview not found" });

    const session = await InterviewResult.findOne({
      user: req.user.userId,
      interview: interviewId,
      status: "in-progress",
    }).sort({ startedAt: -1, createdAt: -1 });
    if (!session) return res.status(404).json({ success: false, message: "No in-progress session found" });
    return res.status(200).json({ success: true, session: sessionPayload(session) });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to find in-progress session" });
  }
});

router.post("/interviews/:interviewId/sessions", async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!validId(interviewId)) {
      return res.status(400).json({ success: false, message: "Invalid interview ID" });
    }
    if (req.body && Object.keys(req.body).length > 0) {
      return res.status(400).json({ success: false, message: "Session data is generated by the server; no request fields are accepted" });
    }

    const interview = await Interview.findOne({ _id: interviewId, user: req.user.userId }).select("_id");
    if (!interview) return res.status(404).json({ success: false, message: "Interview not found" });
    const questions = await Question.find({ interview: interviewId }).sort({ order: 1, _id: 1 });
    if (questions.length === 0) {
      return res.status(400).json({ success: false, message: "Add at least one question before starting a mock interview" });
    }

    const startedAt = new Date();
    const session = await InterviewResult.create({
      user: req.user.userId,
      interview: interviewId,
      status: "in-progress",
      startedAt,
      totalQuestions: questions.length,
      answers: createSessionAnswerSnapshots(questions),
    });
    return res.status(201).json({ success: true, message: "Mock interview session created", session: sessionPayload(session) });
  } catch (error) {
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to create mock interview session" });
  }
});

router.get("/mock-sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!validId(sessionId)) {
      return res.status(400).json({ success: false, message: "Invalid session ID" });
    }
    const session = await InterviewResult.findOne({ _id: sessionId, user: req.user.userId });
    if (!session) return res.status(404).json({ success: false, message: "Mock interview session not found" });
    return res.status(200).json({ success: true, session: sessionPayload(session) });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to retrieve mock interview session" });
  }
});

router.patch("/mock-sessions/:sessionId/answers/:questionId", async (req, res) => {
  try {
    const { sessionId, questionId } = req.params;
    if (!validId(sessionId)) return res.status(400).json({ success: false, message: "Invalid session ID" });
    if (!validId(questionId)) return res.status(400).json({ success: false, message: "Invalid question ID" });
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== "object" ||
        Object.keys(body).length !== 1 || typeof body.answerText !== "string") {
      return res.status(400).json({ success: false, message: "Request body must contain only answerText as a string" });
    }
    if (body.answerText.length > MAX_ANSWER_LENGTH) {
      return res.status(413).json({ success: false, message: `Answer must be ${MAX_ANSWER_LENGTH} characters or fewer` });
    }

    const session = await InterviewResult.findOneAndUpdate(
      {
        _id: sessionId,
        user: req.user.userId,
        status: "in-progress",
        answers: { $elemMatch: { question: questionId } },
      },
      { $set: { "answers.$.answerText": body.answerText } },
      { returnDocument: "after", runValidators: true }
    );
    if (!session) {
      const ownedSession = await InterviewResult.findOne({ _id: sessionId, user: req.user.userId }).select("status answers.question");
      if (!ownedSession) return res.status(404).json({ success: false, message: "Mock interview session not found" });
      if (ownedSession.status !== "in-progress") {
        return res.status(409).json({ success: false, message: "Completed sessions cannot be modified" });
      }
      return res.status(404).json({ success: false, message: "Question is not part of this session" });
    }
    const updatedAnswer = session.answers.find((answer) => String(answer.question) === questionId);
    return res.status(200).json({
      success: true,
      message: "Answer saved",
      saveStatus: "saved",
      answer: {
        question: updatedAnswer.question,
        questionText: updatedAnswer.questionText,
        category: updatedAnswer.category,
        difficulty: updatedAnswer.difficulty,
        order: updatedAnswer.order,
        answerText: updatedAnswer.answerText,
      },
    });
  } catch (error) {
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to save answer" });
  }
});

router.post("/mock-sessions/:sessionId/complete", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!validId(sessionId)) return res.status(400).json({ success: false, message: "Invalid session ID" });
    if (req.body && Object.keys(req.body).length > 0) {
      return res.status(400).json({ success: false, message: "Completion data is generated by the server" });
    }

    const existing = await InterviewResult.findOne({ _id: sessionId, user: req.user.userId });
    if (!existing) return res.status(404).json({ success: false, message: "Mock interview session not found" });
    if (existing.answers.length === 0 || existing.totalQuestions === 0) {
      return res.status(400).json({ success: false, message: "An empty session cannot be completed" });
    }
    if (existing.status === "completed") {
      return res.status(200).json({ success: true, message: "Session already completed", session: sessionPayload(existing) });
    }
    if (!existing.startedAt || Number.isNaN(new Date(existing.startedAt).getTime())) {
      return res.status(409).json({ success: false, message: "Session has no valid start time" });
    }

    const completedAt = new Date();
    const durationSeconds = Math.max(0, Math.floor((completedAt.getTime() - new Date(existing.startedAt).getTime()) / 1000));
    const session = await InterviewResult.findOneAndUpdate(
      { _id: sessionId, user: req.user.userId, status: "in-progress" },
      { $set: { status: "completed", completedAt, durationSeconds } },
      { returnDocument: "after", runValidators: true }
    );
    if (session) return res.status(200).json({ success: true, message: "Mock interview session completed", session: sessionPayload(session) });

    // A concurrent completion may have won; return its persisted timestamps unchanged.
    const completed = await InterviewResult.findOne({ _id: sessionId, user: req.user.userId });
    if (completed?.status === "completed") {
      return res.status(200).json({ success: true, message: "Session already completed", session: sessionPayload(completed) });
    }
    return res.status(409).json({ success: false, message: "Session could not be completed" });
  } catch (error) {
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to complete mock interview session" });
  }
});

export default router;
