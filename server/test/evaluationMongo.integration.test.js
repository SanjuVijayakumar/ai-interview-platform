import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import mockSessionRoutes from "../routes/mockSessionRoutes.js";
import resultRoutes from "../routes/resultRoutes.js";
import InterviewResult from "../models/InterviewResult.js";

const mongoTestUri = process.env.MONGO_TEST_URI;

test("MongoDB evaluation claims enforce BSON dates, ownership, eligibility, and concurrency", {
  skip: mongoTestUri ? false : "Set MONGO_TEST_URI to a dedicated test database; development DB fallback is disabled",
}, async (t) => {
  const parsed = new URL(mongoTestUri);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assert.match(databaseName, /(^|[-_])test($|[-_])/i, "MONGO_TEST_URI must name a dedicated test database");

  const oldSecret = process.env.JWT_SECRET;
  const secret = "mongo-route-test-secret-only";
  process.env.JWT_SECRET = secret;
  const createdIds = [];
  await mongoose.connect(mongoTestUri);
  const app = express();
  app.use(express.json());
  app.use("/api", mockSessionRoutes);
  app.use("/api/results", resultRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (createdIds.length) await InterviewResult.deleteMany({ _id: { $in: createdIds } });
    await mongoose.disconnect();
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  const owner = new mongoose.Types.ObjectId();
  const otherUser = new mongoose.Types.ObjectId();
  async function insert({ user = owner, completedAt = new Date(), evaluationStatus = "not-requested" } = {}) {
    const id = new mongoose.Types.ObjectId();
    const question = new mongoose.Types.ObjectId();
    createdIds.push(id);
    await InterviewResult.collection.insertOne({
      _id: id, user, interview: new mongoose.Types.ObjectId(), status: "completed", completedAt,
      totalQuestions: 1, evaluationStatus, evaluationAttemptCount: 0,
      answers: [{ question, questionText: "Question", category: "Technical", difficulty: "Intermediate", order: 1,
        answerText: "", referenceAnswerSnapshot: "private" }],
    });
    return id;
  }
  async function post(id, { user = owner, retry = false } = {}) {
    const token = jwt.sign({ userId: String(user), role: "user" }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mock-sessions/${id}/evaluation`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ retry }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function get(path) {
    const token = jwt.sign({ userId: String(owner), role: "user" }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  }
  function assertPrivateMetadataHidden(payload) {
    const serialized = JSON.stringify(payload);
    for (const field of ["evaluationModel", "evaluationPromptVersion", "rubricVersion", "rubricWeights", "referenceAnswerSnapshot", "referenceAnswerUsed"]) {
      assert.equal(serialized.includes(field), false, `${field} must not be returned by the API`);
    }
  }

  const validId = await insert();
  const validResponse = await post(validId);
  assert.equal(validResponse.status, 200);
  assert.equal(validResponse.body.evaluation.overallScore, 0);
  assertPrivateMetadataHidden(validResponse.body);
  const persisted = await InterviewResult.collection.findOne({ _id: validId });
  assert.equal(persisted.evaluationAttemptCount, 1);
  assert.equal(persisted.evaluationStatus, "completed");
  assert.ok(persisted.evaluationPromptVersion);

  const evaluationRead = await get(`/api/mock-sessions/${validId}/evaluation`);
  assert.equal(evaluationRead.status, 200);
  assert.equal(evaluationRead.body.evaluation.overallScore, 0);
  assertPrivateMetadataHidden(evaluationRead.body);

  const legacyId = await insert({ evaluationStatus: "completed" });
  await InterviewResult.collection.updateOne({ _id: legacyId }, {
    $set: {
      evaluationModel: "previous-private-model",
      evaluationPromptVersion: "previous-private-prompt",
      rubricVersion: "previous-private-rubric",
      rubricWeights: { clarity: 1 },
      overallScore: 81,
      performanceRating: "strong",
      "answers.0.referenceAnswerUsed": "previous private reference",
    },
  });
  const collectionResponse = await get("/api/results");
  assert.equal(collectionResponse.status, 200);
  assert.ok(collectionResponse.body.results.some((result) => String(result._id) === String(legacyId)));
  assertPrivateMetadataHidden(collectionResponse.body);
  assert.ok(collectionResponse.body.results.find((result) => String(result._id) === String(legacyId)).overallScore === 81);
  const individualResponse = await get(`/api/results/${legacyId}`);
  assert.equal(individualResponse.status, 200);
  assert.equal(individualResponse.body.result.overallScore, 81);
  assertPrivateMetadataHidden(individualResponse.body);

  for (const completedAt of [null, "2026-01-01T00:00:00.000Z", 1767225600000]) {
    const invalidId = await insert({ completedAt });
    const response = await post(invalidId);
    assert.equal(response.status, 409);
    assert.equal((await InterviewResult.collection.findOne({ _id: invalidId })).evaluationAttemptCount, 0);
  }
  const missingDateId = new mongoose.Types.ObjectId();
  createdIds.push(missingDateId);
  await InterviewResult.collection.insertOne({
    _id: missingDateId, user: owner, interview: new mongoose.Types.ObjectId(), status: "completed", totalQuestions: 1,
    evaluationStatus: "not-requested", evaluationAttemptCount: 0,
    answers: [{ question: new mongoose.Types.ObjectId(), questionText: "Question", category: "Technical", difficulty: "Intermediate", order: 1, answerText: "" }],
  });
  assert.equal((await post(missingDateId)).status, 409);
  assert.equal((await InterviewResult.collection.findOne({ _id: missingDateId })).evaluationAttemptCount, 0);

  const foreignId = await insert({ user: otherUser });
  assert.equal((await post(foreignId)).status, 404);
  assert.equal((await InterviewResult.collection.findOne({ _id: foreignId })).evaluationAttemptCount, 0);

  const completedId = await insert({ evaluationStatus: "completed" });
  assert.equal((await post(completedId)).status, 200);
  assert.equal((await InterviewResult.collection.findOne({ _id: completedId })).evaluationAttemptCount, 0);

  const concurrentId = await insert();
  const concurrentResponses = await Promise.all([post(concurrentId), post(concurrentId)]);
  assert.ok(concurrentResponses.every(({ status }) => status === 200 || status === 202));
  const concurrentResult = await InterviewResult.collection.findOne({ _id: concurrentId });
  assert.equal(concurrentResult.evaluationAttemptCount, 1);
  assert.equal(concurrentResult.evaluationStatus, "completed");
});
