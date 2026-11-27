import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import { getAdminDashboardStats } from "../services/adminDashboardStatsService.js";

const generatedAt = new Date("2026-11-27T00:00:02.000Z");
const firstDay = new Date("2026-10-29T00:00:00.000Z");
const tie = new Date("2026-11-27T00:00:00.000Z");
const sessionStart = new Date("2026-11-27T00:00:01.000Z");
const accountCounts = { regular: 0, administrators: 0, unknownRole: 0 };
const evaluationCounts = { "not-requested": 0, pending: 0, completed: 0, failed: 0, unknown: 0 };
const categoryKeys = ["technical", "behavioral", "system-design", "other", "unknown"];
const mongoTestUri = process.env.MONGO_TEST_URI;

function assertEmptyResponse(data) {
  const registrationTrend = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 29 + index)).toISOString().slice(0, 10),
    ...accountCounts,
  }));
  assert.deepEqual(data, {
    generatedAt: generatedAt.toISOString(),
    timezone: "UTC",
    accounts: accountCounts,
    interviews: { total: 0 },
    questions: { total: 0 },
    sessions: { total: 0, completed: 0, inProgress: 0, unknownStatus: 0, completionRatePercent: null },
    evaluations: { averageScore: null, scoredSessions: 0, status: evaluationCounts },
    registrationTrend,
    interviewCategories: categoryKeys.map((category) => ({ category, count: 0 })),
    recentActivity: [],
  });
}

const emptyFacets = {
  User: { accounts: [], trend: [], recent: [] },
  Interview: { categories: [], recent: [] },
  Question: { total: [], recent: [] },
  InterviewResult: { summary: [], started: [], completed: [] },
};

test("statistics execute four bounded aggregate reads and return the exact empty response", async () => {
  const started = [];
  const finish = [];
  const models = Object.fromEntries(Object.entries(emptyFacets).map(([name, facets]) => [
    name,
    {
      aggregate(pipeline) {
        assert.deepEqual(Object.keys(pipeline[1].$facet).sort(), Object.keys(facets).sort());
        return {
          option(options) {
            assert.equal(options.maxTimeMS, 3_000);
            assert.deepEqual(options.collation, { locale: "simple" });
            return this;
          },
          exec() {
            started.push(name);
            return new Promise((resolve) => { finish.push(() => resolve([facets])); });
          },
        };
      },
    },
  ]));
  const pending = getAdminDashboardStats(generatedAt, models);
  assert.deepEqual(started, Object.keys(emptyFacets));
  finish.forEach((resolve) => resolve());
  assertEmptyResponse(await pending);
});

test("MongoDB statistics classify raw BSON and return only bounded, privacy-safe data", {
  skip: mongoTestUri ? false : "Set MONGO_TEST_URI to a dedicated test database; development DB fallback is disabled",
}, async (t) => {
  const databaseName = decodeURIComponent(new URL(mongoTestUri).pathname.slice(1));
  assert.match(databaseName, /(^|[-_])test($|[-_])/i, "MONGO_TEST_URI must name a dedicated test database");
  const connection = await mongoose.createConnection(mongoTestUri, {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  }).asPromise();
  const prefix = `dashboard_stats_${randomUUID().replaceAll("-", "")}`;
  const models = Object.fromEntries(Object.keys(emptyFacets).map((name) => [
    name, connection.model(name, new mongoose.Schema({}), `${prefix}_${name.toLowerCase()}`),
  ]));
  t.after(async () => {
    try {
      for (const { collection } of Object.values(models)) {
        await collection.drop().catch((error) => { if (error.code !== 26) throw error; });
      }
    } finally {
      await connection.close();
    }
  });

  assertEmptyResponse(await getAdminDashboardStats(generatedAt, models));

  const future = new Date(generatedAt.getTime() + 1);
  const previousWindow = new Date(firstDay.getTime() - 1);
  const privateText = "private-person@example.test";
  await models.User.collection.insertMany([
    { role: "user", createdAt: firstDay, email: privateText, password: privateText },
    { role: "admin", createdAt: generatedAt, name: privateText },
    { createdAt: new Date("2026-10-30T00:00:00Z") },
    { role: ["admin"], createdAt: tie },
    { role: "user", createdAt: previousWindow },
    { role: "admin", createdAt: future },
    { role: "user", createdAt: [generatedAt] },
    { role: "admin", createdAt: generatedAt.toISOString() },
    { role: false },
  ]);

  const missingParent = new mongoose.Types.ObjectId();
  const interview = new mongoose.Types.ObjectId();
  await models.Interview.collection.insertMany([
    { _id: interview, category: " Technical ", createdAt: tie, user: missingParent, title: privateText },
    { category: "BEHAVIORAL", createdAt: tie },
    { category: " System-Design " },
    { category: privateText },
    { category: "   " },
    { category: ["technical"], createdAt: [generatedAt] },
    {},
  ]);
  await models.Question.collection.insertMany([
    ...Array.from({ length: 12 }, () => ({ interview: missingParent, createdAt: tie, expectedAnswer: privateText })),
    { createdAt: [generatedAt] },
  ]);

  const evaluated = { status: "completed", evaluationStatus: "completed", interview, user: missingParent };
  const invalidScores = [
    null, undefined, "90", [], [80], NaN, Infinity, -Infinity, -1, 101, {},
    mongoose.Types.Decimal128.fromString("NaN"), mongoose.Types.Decimal128.fromString("Infinity"),
  ];
  const attemptWithScore = (overallScore) => overallScore === undefined
    ? { ...evaluated, totalScore: 80 }
    : { ...evaluated, overallScore, totalScore: 80 };
  await models.InterviewResult.collection.insertMany([
    attemptWithScore(0),
    { ...attemptWithScore(100), interview: missingParent },
    {
      ...attemptWithScore(mongoose.Types.Decimal128.fromString("50.75")),
      startedAt: sessionStart,
      completedAt: generatedAt,
      answers: [{ answerText: privateText, referenceAnswerSnapshot: privateText }],
      overallFeedback: privateText,
    },
    ...invalidScores.map(attemptWithScore),
    ...[null, "not-requested", "pending", "failed", ["completed"], false].map((evaluationStatus) => ({
      status: "completed", evaluationStatus, overallScore: 90,
    })),
    { status: "completed", overallScore: 90, completedAt: [generatedAt] },
    { status: "in-progress", evaluationStatus: "completed", overallScore: 90, completedAt: generatedAt },
    { status: "in-progress", startedAt: future },
    { status: "in-progress" },
    { status: ["completed"], completedAt: generatedAt },
    {},
    { status: "scheduled" },
  ]);

  const data = await getAdminDashboardStats(generatedAt, models);
  assert.deepEqual(data.accounts, { regular: 3, administrators: 3, unknownRole: 3 });
  assert.deepEqual(data.interviews, { total: 7 });
  assert.deepEqual(data.questions, { total: 13 });
  assert.deepEqual(data.sessions, {
    total: 29, completed: 23, inProgress: 3, unknownStatus: 3, completionRatePercent: 88.5,
  });
  assert.deepEqual(data.evaluations, {
    averageScore: 50.3,
    scoredSessions: 3,
    status: { "not-requested": 3, pending: 1, completed: 16, failed: 1, unknown: 2 },
  });
  assert.equal(Object.values(data.evaluations.status).reduce((sum, count) => sum + count), data.sessions.completed);
  assert.deepEqual(data.interviewCategories, categoryKeys.map((category, index) => ({
    category, count: [1, 1, 1, 1, 3][index],
  })));
  const populatedDays = data.registrationTrend.filter((day) => day.regular || day.administrators || day.unknownRole);
  assert.equal(data.registrationTrend.length, 30);
  assert.deepEqual(populatedDays, [
    { date: "2026-10-29", ...accountCounts, regular: 1 },
    { date: "2026-10-30", ...accountCounts, unknownRole: 1 },
    { date: "2026-11-27", ...accountCounts, administrators: 1, unknownRole: 1 },
  ]);
  const event = (type, date) => ({ type, occurredAt: date.toISOString() });
  assert.deepEqual(data.recentActivity, [
    event("account-created", generatedAt),
    event("session-completed", generatedAt),
    event("session-started", sessionStart),
    event("account-created", tie),
    event("interview-created", tie),
    event("interview-created", tie),
    ...Array.from({ length: 4 }, () => event("question-saved", tie)),
  ]);
  assert.deepEqual(await getAdminDashboardStats(generatedAt, models), data);
  assert.doesNotMatch(JSON.stringify(data), /private-person|_id|answerText|overallFeedback|password/i);
});
