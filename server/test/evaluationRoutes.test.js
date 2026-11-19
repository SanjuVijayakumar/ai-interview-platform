import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import mockSessionRoutes from "../routes/mockSessionRoutes.js";
import resultRoutes from "../routes/resultRoutes.js";
import InterviewResult from "../models/InterviewResult.js";

const userId = new mongoose.Types.ObjectId();
const interviewId = new mongoose.Types.ObjectId();
const questionId = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId();
const testSecret = "route-test-secret-only";

function makeSession(overrides = {}) {
  return {
    _id: sessionId,
    user: userId,
    interview: interviewId,
    status: "completed",
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
    totalQuestions: 1,
    answers: [{
      question: questionId,
      questionText: "Explain a hash map.",
      category: "Technical",
      difficulty: "Intermediate",
      order: 1,
      answerText: "",
      referenceAnswerSnapshot: "Private reference text",
      toObject() { const { toObject: _method, ...answer } = this; return answer; },
    }],
    evaluationStatus: "not-requested",
    evaluationAttemptCount: 0,
    ...overrides,
  };
}

async function withApi(t, { session = makeSession(), beforeClaim, findOne } = {}) {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  const originalFindOne = InterviewResult.findOne;
  const originalFindOneAndUpdate = InterviewResult.findOneAndUpdate;
  const originalFind = InterviewResult.find;
  let claimFilter;
  let claimCount = 0;
  let current = session;

  InterviewResult.findOne = findOne || (async () => current);
  InterviewResult.findOneAndUpdate = async (filter, update) => {
    if (filter.status === "completed") {
      claimFilter = filter;
      if (beforeClaim) return beforeClaim({ filter, current, claimCount: ++claimCount });
      claimCount += 1;
      if (filter.completedAt?.$type !== "date" || !(current.completedAt instanceof Date) ||
          current.status !== "completed" || String(current.user) !== String(filter.user)) return null;
      if (filter.evaluationStatus === "failed" && current.evaluationStatus !== "failed") return null;
      if (filter.$or && current.evaluationStatus !== "not-requested" && current.evaluationStatus != null) return null;
      if (current.evaluationStatus === "pending" || current.evaluationStatus === "completed") return null;
      current = { ...current, ...update.$set, evaluationAttemptCount: current.evaluationAttemptCount + 1 };
      return { ...current, answers: current.answers };
    }
    current = { ...current, ...update.$set };
    return current;
  };

  const app = express();
  app.use(express.json());
  app.use("/api", mockSessionRoutes);
  app.use("/api/results", resultRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    InterviewResult.findOne = originalFindOne;
    InterviewResult.findOneAndUpdate = originalFindOneAndUpdate;
    InterviewResult.find = originalFind;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  const token = jwt.sign({ userId: String(userId), role: "user" }, testSecret);
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, get claimFilter() { return claimFilter; }, get claimCount() { return claimCount; } };
}

const evaluationPath = `/api/mock-sessions/${sessionId}/evaluation`;

test("evaluation endpoint requires an explicit boolean retry field before claiming", async (t) => {
  const api = await withApi(t);
  for (const body of [{}, undefined, { retry: "true" }, { retry: 1 }, { retry: null }, { retry: false, extra: true }]) {
    const response = await api.request(evaluationPath, { method: "POST", ...(body === undefined ? {} : { body }) });
    assert.equal(response.status, 400);
  }
  assert.equal(api.claimCount, 0);
});

test("explicit retry false and true pass request validation", async (t) => {
  const pending = await withApi(t, { session: makeSession({ evaluationStatus: "pending" }) });
  assert.equal((await pending.request(evaluationPath, { method: "POST", body: { retry: false } })).status, 202);
  assert.equal((await pending.request(evaluationPath, { method: "POST", body: { retry: true } })).status, 202);

  const failed = await withApi(t, { session: makeSession({ evaluationStatus: "failed", evaluationAttemptCount: 1 }) });
  const response = await failed.request(evaluationPath, { method: "POST", body: { retry: true } });
  assert.equal(response.status, 200);
  assert.equal(response.body.evaluationStatus, undefined);
  assert.equal(response.body.status, "completed");
});

test("completed evaluations are returned idempotently without another claim", async (t) => {
  const api = await withApi(t, { session: makeSession({ evaluationStatus: "completed", overallScore: 84 }) });
  const response = await api.request(evaluationPath, { method: "POST", body: { retry: false } });
  assert.equal(response.status, 200);
  assert.equal(response.body.evaluation.overallScore, 84);
  assert.equal(api.claimCount, 0);
});

test("evaluation claim requires BSON date type, ownership, completed status, and eligible state", async (t) => {
  const api = await withApi(t);
  const response = await api.request(evaluationPath, { method: "POST", body: { retry: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(api.claimFilter.completedAt, { $type: "date" });
  assert.equal(String(api.claimFilter._id), String(sessionId));
  assert.equal(String(api.claimFilter.user), String(userId));
  assert.equal(api.claimFilter.status, "completed");
  assert.ok(api.claimFilter.$or);

  for (const completedAt of [undefined, null, "2026-01-01T00:00:00.000Z", 1767225600000]) {
    const invalid = await withApi(t, { session: makeSession({ completedAt }) });
    const rejected = await invalid.request(evaluationPath, { method: "POST", body: { retry: false } });
    assert.equal(rejected.status, 409);
    assert.equal(invalid.claimCount, 0);
  }

  let ownerFilter;
  const otherUser = await withApi(t, {
    session: makeSession({ user: new mongoose.Types.ObjectId() }),
    findOne: async (filter) => { ownerFilter = filter; return null; },
  });
  assert.equal((await otherUser.request(evaluationPath, { method: "POST", body: { retry: false } })).status, 404);
  assert.equal(otherUser.claimCount, 0);
  assert.equal(String(ownerFilter.user), String(userId));

  const wrongStatus = await withApi(t, { session: makeSession({ status: "in-progress" }) });
  assert.equal((await wrongStatus.request(evaluationPath, { method: "POST", body: { retry: false } })).status, 409);
  assert.equal(wrongStatus.claimCount, 0);
});

test("evaluation response retains public scores while omitting internal metadata", async (t) => {
  const api = await withApi(t);
  const response = await api.request(evaluationPath, { method: "POST", body: { retry: false } });
  assert.equal(response.status, 200);
  assert.equal(response.body.evaluation.status, "completed");
  assert.equal(response.body.evaluation.overallScore, 0);
  const serialized = JSON.stringify(response.body);
  for (const field of ["evaluationModel", "evaluationPromptVersion", "rubricVersion", "rubricWeights", "referenceAnswerSnapshot", "referenceAnswerUsed"]) {
    assert.equal(serialized.includes(field), false, `${field} must be private`);
  }
});

test("failed evaluations require explicit retry and retry claims only failed results", async (t) => {
  const previousProvider = process.env.AI_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  const previousGeminiModel = process.env.GEMINI_MODEL;
  process.env.AI_PROVIDER = "gemini";
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  t.after(() => {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiApiKey;
    if (previousGeminiModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousGeminiModel;
  });
  const session = makeSession({ answers: [{
    question: questionId,
    questionText: "Explain a hash map.",
    category: "Technical",
    difficulty: "Intermediate",
    order: 1,
    answerText: "A hash map stores key value pairs.",
    referenceAnswerSnapshot: "Private reference text",
    toObject() { const { toObject: _method, ...answer } = this; return answer; },
  }] });
  const api = await withApi(t, { session });
  const first = await api.request(evaluationPath, { method: "POST", body: { retry: false } });
  assert.equal(first.status, 502);
  assert.equal(first.body.status, "failed");
  assert.equal(first.body.attemptCount, 1);

  const noRetry = await api.request(evaluationPath, { method: "POST", body: { retry: false } });
  assert.equal(noRetry.status, 409);
  assert.equal(api.claimCount, 1);

  const retried = await api.request(evaluationPath, { method: "POST", body: { retry: true } });
  assert.equal(retried.status, 502);
  assert.equal(retried.body.status, "failed");
  assert.equal(retried.body.attemptCount, 2);
  assert.equal(api.claimCount, 2);
  assert.equal(api.claimFilter.evaluationStatus, "failed");
});

test("result collection and individual HTTP responses sanitize previously persisted metadata", async (t) => {
  const oldFind = InterviewResult.find;
  const oldFindOne = InterviewResult.findOne;
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  const persisted = InterviewResult.hydrate({
    _id: sessionId, user: userId, interview: interviewId, status: "completed", totalQuestions: 1,
    completedAt: new Date(), evaluationStatus: "completed", evaluationModel: "private-model-name",
    evaluationPromptVersion: "internal-prompt", rubricVersion: "internal-rubric", rubricWeights: { clarity: 1 },
    overallScore: 80, performanceRating: "strong", answers: [{ question: questionId, questionText: "Question", answerText: "Answer",
      referenceAnswerSnapshot: "private snapshot", referenceAnswerUsed: "private used reference", answerScore: 80 }],
  });
  const query = (value) => ({ populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  InterviewResult.find = () => query([persisted]);
  InterviewResult.findOne = () => query(persisted);

  const app = express();
  app.use("/api/results", resultRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    InterviewResult.find = oldFind;
    InterviewResult.findOne = oldFindOne;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });
  const token = jwt.sign({ userId: String(userId), role: "user" }, testSecret);
  for (const path of ["/api/results", `/api/results/${sessionId}`]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(await response.json());
    for (const field of ["evaluationModel", "evaluationPromptVersion", "rubricVersion", "rubricWeights", "referenceAnswerSnapshot", "referenceAnswerUsed"]) {
      assert.equal(serialized.includes(field), false, `${field} must be private from ${path}`);
    }
    assert.ok(serialized.includes("overallScore"));
    assert.ok(serialized.includes("performanceRating"));
    assert.ok(serialized.includes("answerScore"));
  }
});

test("concurrent evaluation requests cannot both claim a session", async (t) => {
  let status = "not-requested";
  let attempts = 0;
  const api = await withApi(t, {
    session: makeSession(),
    beforeClaim: async ({ current: latest }) => {
      if (status !== "not-requested") return null;
      status = "pending";
      attempts += 1;
      const claimed = { ...latest, evaluationStatus: "pending", evaluationAttemptCount: attempts };
      Object.assign(latest, claimed);
      return claimed;
    },
  });
  const responses = await Promise.all([
    api.request(evaluationPath, { method: "POST", body: { retry: false } }),
    api.request(evaluationPath, { method: "POST", body: { retry: false } }),
  ]);
  assert.ok(responses.every(({ status: code }) => code === 200 || code === 202));
  assert.equal(attempts, 1);
});
