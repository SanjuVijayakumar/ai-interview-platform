import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import InterviewResult from "../models/InterviewResult.js";
import { createSessionAnswerSnapshots, sessionPayload } from "../utils/mockSessionData.js";

const userId = new mongoose.Types.ObjectId();
const interviewId = new mongoose.Types.ObjectId();

function makeQuestion(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    questionText: "Explain how a hash map works.",
    expectedAnswer: "A hash map stores key-value pairs and uses a hash function.",
    category: "Technical",
    difficulty: "Intermediate",
    order: 1,
    ...overrides,
  };
}

function makeResult(answers) {
  return new InterviewResult({
    user: userId,
    interview: interviewId,
    totalQuestions: answers.length,
    answers,
  });
}

test("session snapshots preserve expected answers as of session creation", () => {
  const question = makeQuestion();
  const snapshots = createSessionAnswerSnapshots([question]);
  question.expectedAnswer = "A later edit to the reference answer.";

  assert.equal(snapshots[0].referenceAnswerSnapshot, "A hash map stores key-value pairs and uses a hash function.");
  assert.equal(snapshots[0].answerText, "");
});

test("questions without an expected answer receive an empty snapshot", () => {
  const [snapshot] = createSessionAnswerSnapshots([makeQuestion({ expectedAnswer: "" })]);
  assert.equal(snapshot.referenceAnswerSnapshot, "");

  const [missingSnapshot] = createSessionAnswerSnapshots([makeQuestion({ expectedAnswer: undefined })]);
  assert.equal(missingSnapshot.referenceAnswerSnapshot, "");
});

test("mock-session payload keeps established answer fields and omits private reference snapshots", () => {
  const [answer] = createSessionAnswerSnapshots([makeQuestion()]);
  answer.answerText = "A hash map stores values using keys.";
  const result = makeResult([answer]);
  const payload = sessionPayload(result);

  assert.deepEqual(Object.keys(payload.answers[0]).sort(), [
    "answerText", "category", "difficulty", "order", "question", "questionText",
  ]);
  assert.equal(payload.answers[0].answerText, "A hash map stores values using keys.");
  assert.equal(JSON.stringify(payload).includes("referenceAnswerSnapshot"), false);
});

test("generic InterviewResult JSON serialization also omits private reference snapshots", () => {
  const [answer] = createSessionAnswerSnapshots([makeQuestion()]);
  answer.referenceAnswerUsed = answer.referenceAnswerSnapshot;
  const result = makeResult([answer]);

  assert.equal(result.answers[0].referenceAnswerSnapshot, "A hash map stores key-value pairs and uses a hash function.");
  assert.equal(result.answers[0].referenceAnswerUsed, "A hash map stores key-value pairs and uses a hash function.");
  assert.equal(JSON.stringify(result).includes("referenceAnswerSnapshot"), false);
  assert.equal(JSON.stringify(result).includes("referenceAnswerUsed"), false);
});

test("evaluation fields default without fabricating scores and legacy fields remain intact", () => {
  const [answer] = createSessionAnswerSnapshots([makeQuestion()]);
  const result = makeResult([answer]);

  assert.equal(result.evaluationStatus, "not-requested");
  assert.equal(result.evaluationRequestedAt, null);
  assert.equal(result.evaluationStartedAt, null);
  assert.equal(result.evaluationCompletedAt, null);
  assert.equal(result.evaluationFailedAt, null);
  assert.equal(result.evaluationErrorCode, null);
  assert.equal(result.evaluationAttemptCount, 0);
  assert.equal(result.evaluationModel, null);
  assert.equal(result.evaluationPromptVersion, null);
  assert.equal(result.rubricVersion, null);
  assert.equal(result.overallScore, null);
  assert.equal(result.performanceRating, null);
  assert.equal(result.answeredCount, null);
  assert.equal(result.unansweredCount, null);
  assert.equal(result.answers[0].answerScore, null);
  assert.deepEqual(result.answers[0].dimensions, []);
  assert.equal(result.answers[0].isUnanswered, false);
  assert.equal(result.answers[0].score, 0);
  assert.equal(result.answers[0].feedback, "");
  assert.equal(result.totalScore, 0);
  assert.equal(result.overallFeedback, "");
});

test("evaluation scores enforce the 0–100 range", async () => {
  const [answer] = createSessionAnswerSnapshots([makeQuestion()]);
  const result = makeResult([{ ...answer, answerScore: 101 }]);
  await assert.rejects(result.validate(), (error) => error.name === "ValidationError");
});

test("legacy hydrated results remain readable without fabricated evaluation scores", () => {
  const id = new mongoose.Types.ObjectId();
  const legacy = InterviewResult.hydrate({
    _id: id,
    user: userId,
    interview: interviewId,
    totalQuestions: 0,
    answers: [],
    status: "completed",
    totalScore: 0,
    overallFeedback: "",
  });

  assert.equal(legacy.status, "completed");
  assert.equal(legacy.evaluationStatus, "not-requested");
  assert.equal(legacy.overallScore, null);
  assert.equal(legacy.totalScore, 0);
  assert.equal(legacy.overallFeedback, "");
});
