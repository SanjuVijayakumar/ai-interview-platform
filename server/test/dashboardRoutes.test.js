import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import Interview from "../models/Interview.js";
import InterviewResult from "../models/InterviewResult.js";
import dashboardRoutes from "../routes/dashboardRoutes.js";

const testSecret = "dashboard-route-test-secret-only";
const statsPath = "/api/dashboard/stats";

function sameId(left, right) {
  return String(left) === String(right);
}

function queryResult(value, onSelect) {
  return {
    select(fields) {
      onSelect?.(fields);
      return this;
    },
    lean() {
      return Promise.resolve(value);
    },
  };
}

async function withApi(t, { interviews = [], sessions = [] } = {}) {
  const oldSecret = process.env.JWT_SECRET;
  const originalInterviewFind = Interview.find;
  const originalResultFind = InterviewResult.find;
  process.env.JWT_SECRET = testSecret;

  let interviewFilter;
  let interviewProjection;
  let resultFilter;
  let resultProjection;
  Interview.find = (filter) => {
    interviewFilter = filter;
    return queryResult(
      interviews.filter((interview) => sameId(interview.user, filter.user)),
      (fields) => { interviewProjection = fields; },
    );
  };
  InterviewResult.find = (filter) => {
    resultFilter = filter;
    return queryResult(
      sessions.filter((session) =>
        sameId(session.user, filter.user) &&
        filter.status === session.status &&
        filter.interview.$in.some((interviewId) => sameId(interviewId, session.interview)),
      ),
      (fields) => { resultProjection = fields; },
    );
  };

  const app = express();
  app.use("/api/dashboard", dashboardRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    Interview.find = originalInterviewFind;
    InterviewResult.find = originalResultFind;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  const request = async ({ userId, token, query = "" } = {}) => {
    const authorization = token || (userId
      ? `Bearer ${jwt.sign({ userId: String(userId), role: "user" }, testSecret)}`
      : undefined);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${statsPath}${query}`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    request,
    get interviewFilter() { return interviewFilter; },
    get interviewProjection() { return interviewProjection; },
    get resultFilter() { return resultFilter; },
    get resultProjection() { return resultProjection; },
  };
}

function makeInterview(user, overrides = {}) {
  return { _id: new mongoose.Types.ObjectId(), user, status: "scheduled", ...overrides };
}

function makeSession(user, interview, overrides = {}) {
  return { user, interview, status: "completed", ...overrides };
}

test("dashboard statistics require authentication", async (t) => {
  const api = await withApi(t);
  const response = await api.request();
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.equal(api.interviewFilter, undefined);
});

test("zero interviews return zero counts and no average without querying sessions", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const api = await withApi(t);
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    totalInterviews: 0,
    completedInterviews: 0,
    pendingInterviews: 0,
    averageScore: null,
  });
  assert.equal(api.resultFilter, undefined);
});

test("interviews without completed sessions remain pending regardless of Interview.status", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interviews = [
    makeInterview(user),
    makeInterview(user, { status: "in-progress" }),
    makeInterview(user, { status: "completed" }),
  ];
  const api = await withApi(t, { interviews });
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    totalInterviews: 3,
    completedInterviews: 0,
    pendingInterviews: 3,
    averageScore: null,
  });
});

test("completed sessions count interviews distinctly, including sessions without evaluations", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const first = makeInterview(user);
  const second = makeInterview(user);
  const sessions = [
    makeSession(user, first._id, { evaluationStatus: "not-requested" }),
    makeSession(user, first._id, { evaluationStatus: "completed", overallScore: 0 }),
    makeSession(user, first._id, { evaluationStatus: "completed", overallScore: 80.2 }),
    makeSession(user, second._id, { evaluationStatus: "completed", overallScore: 80.3 }),
  ];
  const api = await withApi(t, { interviews: [first, second], sessions });
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    totalInterviews: 2,
    completedInterviews: 2,
    pendingInterviews: 0,
    averageScore: 53.5,
  });
  assert.deepEqual(Object.keys(response.body).sort(), [
    "averageScore", "completedInterviews", "pendingInterviews", "totalInterviews",
  ]);
  assert.equal(api.resultProjection, "interview evaluationStatus overallScore");
});

test("null, missing, nonnumeric, and out-of-range scores are excluded", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user);
  const sessions = [
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: null }),
    makeSession(user, interview._id, { evaluationStatus: "completed" }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: "90" }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: -1 }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: 101 }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: Number.NaN }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: Number.POSITIVE_INFINITY }),
  ];
  const api = await withApi(t, { interviews: [interview], sessions });
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.completedInterviews, 1);
  assert.equal(response.body.averageScore, null);
});

test("pending, failed, and in-progress sessions do not contribute evaluation scores", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user);
  const sessions = [
    makeSession(user, interview._id, { evaluationStatus: "pending", overallScore: 90 }),
    makeSession(user, interview._id, { evaluationStatus: "failed", overallScore: 80 }),
    makeSession(user, interview._id, { status: "in-progress", evaluationStatus: "completed", overallScore: 100 }),
  ];
  const api = await withApi(t, { interviews: [interview], sessions });
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.completedInterviews, 1);
  assert.equal(response.body.pendingInterviews, 0);
  assert.equal(response.body.averageScore, null);
});

test("statistics isolate users and exclude mismatched and orphaned result references", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const otherUser = new mongoose.Types.ObjectId();
  const ownedInterview = makeInterview(user);
  const foreignInterview = makeInterview(otherUser);
  const sessions = [
    makeSession(user, ownedInterview._id, { evaluationStatus: "completed", overallScore: 92 }),
    makeSession(otherUser, ownedInterview._id, { evaluationStatus: "completed", overallScore: 100 }),
    makeSession(user, foreignInterview._id, { evaluationStatus: "completed", overallScore: 100 }),
    makeSession(user, new mongoose.Types.ObjectId(), { evaluationStatus: "completed", overallScore: 100 }),
  ];
  const api = await withApi(t, {
    interviews: [ownedInterview, foreignInterview],
    sessions,
  });
  const response = await api.request({ userId: user, query: `?userId=${otherUser}` });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    totalInterviews: 1,
    completedInterviews: 1,
    pendingInterviews: 0,
    averageScore: 92,
  });
  assert.equal(String(api.interviewFilter.user), String(user));
  assert.equal(String(api.resultFilter.user), String(user));
  assert.deepEqual(api.resultFilter.interview.$in.map(String), [String(ownedInterview._id)]);
  assert.equal(api.resultFilter.status, "completed");
  assert.equal(api.interviewProjection, "_id");
});

test("average scores round to one decimal place with ties rounded upward", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user);
  const sessions = [
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: 80.2 }),
    makeSession(user, interview._id, { evaluationStatus: "completed", overallScore: 80.3 }),
  ];
  const api = await withApi(t, { interviews: [interview], sessions });
  const response = await api.request({ userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.averageScore, 80.3);
});
