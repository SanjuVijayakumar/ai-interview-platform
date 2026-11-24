import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import Interview from "../models/Interview.js";
import InterviewResult from "../models/InterviewResult.js";
import interviewRoutes from "../routes/interviewRoutes.js";

const testSecret = "interview-routes-test-secret-only";

function sameId(left, right) {
  return String(left) === String(right);
}

function makeInterview(user, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user,
    title: "Frontend Engineer",
    category: "Engineering",
    difficulty: "Intermediate",
    status: "scheduled",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    toObject() {
      const { toObject: _toObject, ...interview } = this;
      return interview;
    },
    ...overrides,
  };
}

function makeSession(user, interview, status, overrides = {}) {
  return { user, interview, status, ...overrides };
}

function queryResults(value, onSelect) {
  return {
    sort() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
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
  const originals = {
    find: Interview.find,
    findOne: Interview.findOne,
    create: Interview.create,
    findOneAndUpdate: Interview.findOneAndUpdate,
    findOneAndDelete: Interview.findOneAndDelete,
    resultFind: InterviewResult.find,
  };
  process.env.JWT_SECRET = testSecret;

  const calls = { interviewFind: 0, resultFind: 0, resultFilters: [], resultProjection: "", created: null, update: null };
  Interview.find = (filter) => {
    calls.interviewFind += 1;
    return queryResults(interviews.filter((interview) => sameId(interview.user, filter.user)));
  };
  Interview.findOne = async (filter) => interviews.find((interview) =>
    sameId(interview._id, filter._id) && sameId(interview.user, filter.user),
  ) || null;
  Interview.create = async (document) => {
    calls.created = document;
    return { _id: new mongoose.Types.ObjectId(), ...document };
  };
  Interview.findOneAndUpdate = async (filter, update) => {
    calls.update = { filter, update };
    const interview = interviews.find((item) =>
      sameId(item._id, filter._id) && sameId(item.user, filter.user),
    );
    return interview ? { ...interview, ...update.$set } : null;
  };
  Interview.findOneAndDelete = async (filter) => interviews.find((interview) =>
    sameId(interview._id, filter._id) && sameId(interview.user, filter.user),
  ) || null;
  InterviewResult.find = (filter) => {
    calls.resultFind += 1;
    calls.resultFilters.push(filter);
    return {
      select(fields) {
        calls.resultProjection = fields;
        return this;
      },
      lean() {
        const ids = filter.interview.$in;
        return Promise.resolve(sessions
          .filter((session) =>
            sameId(session.user, filter.user) &&
            ids.some((id) => sameId(id, session.interview)) &&
            filter.status.$in.includes(session.status),
          )
          .map(({ user: _user, answers: _answers, overallFeedback: _overallFeedback, ...metadata }) => metadata));
      },
    };
  };

  const app = express();
  app.use(express.json());
  app.use("/api/interviews", interviewRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    Interview.find = originals.find;
    Interview.findOne = originals.findOne;
    Interview.create = originals.create;
    Interview.findOneAndUpdate = originals.findOneAndUpdate;
    Interview.findOneAndDelete = originals.findOneAndDelete;
    InterviewResult.find = originals.resultFind;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  const request = async (path, { userId, token, method = "GET", body } = {}) => {
    const authorization = token || (userId
      ? `Bearer ${jwt.sign({ userId: String(userId), role: "user" }, testSecret)}`
      : undefined);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/interviews${path}`, {
      method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls };
}

test("interview list derives scheduled, in-progress, and completed status with completed precedence", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const withoutSessions = makeInterview(user, { title: "No sessions" });
  const active = makeInterview(user, { title: "Active session" });
  const completed = makeInterview(user, { title: "Completed session" });
  const repeatedCompletions = makeInterview(user, { title: "Multiple completed sessions" });
  const completedAndActive = makeInterview(user, { title: "Completed and active" });
  const interviews = [withoutSessions, active, completed, repeatedCompletions, completedAndActive];
  const sessions = [
    makeSession(user, active._id, "in-progress"),
    makeSession(user, completed._id, "completed"),
    makeSession(user, repeatedCompletions._id, "completed"),
    makeSession(user, repeatedCompletions._id, "completed"),
    makeSession(user, completedAndActive._id, "in-progress"),
    makeSession(user, completedAndActive._id, "completed"),
  ];
  const api = await withApi(t, { interviews, sessions });
  const response = await api.request("/", { userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.count, interviews.length);
  const byTitle = Object.fromEntries(response.body.interviews.map((item) => [item.title, item]));
  assert.equal(byTitle["No sessions"].practiceStatus, "scheduled");
  assert.equal(byTitle["Active session"].practiceStatus, "in-progress");
  assert.equal(byTitle["Completed session"].practiceStatus, "completed");
  assert.equal(byTitle["Multiple completed sessions"].practiceStatus, "completed");
  assert.equal(byTitle["Completed and active"].practiceStatus, "completed");
  assert.equal(byTitle["Completed and active"].status, "scheduled");
  assert.equal(api.calls.interviewFind, 1);
  assert.equal(api.calls.resultFind, 1);
  assert.equal(api.calls.resultProjection, "interview status");
  assert.deepEqual(api.calls.resultFilters[0].status.$in, ["completed", "in-progress"]);
});

test("interview detail returns the derived status and preserves stored status and response fields", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user, { status: "scheduled" });
  const session = makeSession(user, interview._id, "completed");
  const api = await withApi(t, { interviews: [interview], sessions: [session] });
  const response = await api.request(`/${interview._id}`, { userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.interview.practiceStatus, "completed");
  assert.equal(response.body.interview.status, "scheduled");
  assert.equal(response.body.interview.title, interview.title);
  assert.equal(api.calls.resultFind, 1);
  assert.deepEqual(api.calls.resultFilters[0].interview.$in.map(String), [String(interview._id)]);
});

test("practice status is scoped to the authenticated user and owned interviews", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const otherUser = new mongoose.Types.ObjectId();
  const owned = makeInterview(user, { title: "Owned interview" });
  const foreign = makeInterview(otherUser, { title: "Foreign interview" });
  const sessions = [
    makeSession(otherUser, owned._id, "completed"),
    makeSession(user, foreign._id, "completed"),
    makeSession(user, new mongoose.Types.ObjectId(), "completed"),
  ];
  const api = await withApi(t, { interviews: [owned, foreign], sessions });
  const response = await api.request("/", { userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.interviews.length, 1);
  assert.equal(response.body.interviews[0].practiceStatus, "scheduled");
  assert.equal(String(api.calls.resultFilters[0].user), String(user));
  assert.deepEqual(api.calls.resultFilters[0].interview.$in.map(String), [String(owned._id)]);
});

test("invalid legacy session states and evaluation failures do not override practice status", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user);
  const sessions = [
    makeSession(user, interview._id, "failed"),
    makeSession(user, interview._id, "pending"),
    makeSession(user, interview._id, "in-progress", { evaluationStatus: "failed" }),
  ];
  const api = await withApi(t, { interviews: [interview], sessions });
  const response = await api.request("/", { userId: user });

  assert.equal(response.status, 200);
  assert.equal(response.body.interviews[0].practiceStatus, "in-progress");
});

test("list response performs one session metadata query and exposes no session content", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interviews = [makeInterview(user), makeInterview(user)];
  const sessions = interviews.map((interview) => makeSession(user, interview._id, "completed", {
    answers: [{ answerText: "private answer" }],
    overallFeedback: "private feedback",
    evaluationStatus: "completed",
  }));
  const api = await withApi(t, { interviews, sessions });
  const response = await api.request("/", { userId: user });
  const serialized = JSON.stringify(response.body);

  assert.equal(response.status, 200);
  assert.equal(api.calls.interviewFind, 1);
  assert.equal(api.calls.resultFind, 1);
  assert.equal(serialized.includes("answers"), false);
  assert.equal(serialized.includes("private answer"), false);
  assert.equal(serialized.includes("private feedback"), false);
  assert.equal(serialized.includes("evaluationStatus"), false);
});

test("create and update cannot persist practiceStatus and retain CRUD response wrappers", async (t) => {
  const user = new mongoose.Types.ObjectId();
  const interview = makeInterview(user);
  const api = await withApi(t, { interviews: [interview] });
  const created = await api.request("/", {
    userId: user,
    method: "POST",
    body: {
      title: "New interview",
      category: "Engineering",
      difficulty: "Beginner",
      practiceStatus: "completed",
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.success, true);
  assert.equal(created.body.interview.title, "New interview");
  assert.equal(Object.hasOwn(api.calls.created, "practiceStatus"), false);
  assert.equal(Object.hasOwn(created.body.interview, "practiceStatus"), false);

  const updated = await api.request(`/${interview._id}`, {
    userId: user,
    method: "PATCH",
    body: { title: "Updated title", practiceStatus: "completed" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.success, true);
  assert.equal(updated.body.interview.title, "Updated title");
  assert.equal(updated.body.interview.practiceStatus, undefined);
  assert.deepEqual(api.calls.update.update.$set, { title: "Updated title" });

  const attemptOnly = await api.request(`/${interview._id}`, {
    userId: user,
    method: "PATCH",
    body: { practiceStatus: "completed" },
  });
  assert.equal(attemptOnly.status, 400);
  assert.deepEqual(api.calls.update.update.$set, { title: "Updated title" });
});

test("interview list and detail require authentication", async (t) => {
  const api = await withApi(t);
  const listResponse = await api.request("/");
  const detailResponse = await api.request(`/${new mongoose.Types.ObjectId()}`);

  assert.equal(listResponse.status, 401);
  assert.equal(detailResponse.status, 401);
  assert.equal(api.calls.interviewFind, 0);
  assert.equal(api.calls.resultFind, 0);
});
