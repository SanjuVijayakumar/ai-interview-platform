import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import authMiddleware from "../middleware/authMiddleware.js";

const TEST_SECRET = "auth-middleware-isolated-test-secret";
const OTHER_SECRET = "different-auth-test-secret";

function createToken(payload, options) {
  return jwt.sign(payload, TEST_SECRET, options);
}

function createUser(userId, role, extra = {}) {
  return {
    _id: new mongoose.Types.ObjectId(userId),
    role,
    name: "Test User",
    email: "auth-test@example.test",
    password: "must-not-be-selected",
    ...extra,
  };
}

function setup(t, lookup = (userId) => createUser(userId, "user")) {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const lookups = [];
  const projections = [];
  process.env.JWT_SECRET = TEST_SECRET;
  User.findById = (userId) => {
    lookups.push(String(userId));
    return {
      select(fields) {
        projections.push(fields);
        return this;
      },
      lean() {
        return Promise.resolve().then(() => lookup(String(userId)));
      },
    };
  };

  t.after(() => {
    User.findById = originalFindById;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  return {
    lookups,
    projections,
    async invoke(authorization) {
      const req = {
        headers: authorization === undefined ? {} : { authorization },
      };
      const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };
      let nextCalls = 0;
      await authMiddleware(req, res, () => {
        nextCalls += 1;
      });
      return { req, res, nextCalls };
    },
  };
}

function assertInvalidAuthentication(result) {
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, {
    success: false,
    message: "Invalid authentication token.",
  });
  assert.equal(result.nextCalls, 0);
}

test("valid regular user uses the database identity and only selects identity fields", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, (requestedId) => createUser(requestedId, "user"));
  const token = createToken({ userId, role: "user" });
  const result = await api.invoke(`Bearer ${token}`);

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.req.user, { userId, role: "user" });
  assert.deepEqual(api.lookups, [userId]);
  assert.deepEqual(api.projections, ["_id role"]);
  assert.equal(Object.hasOwn(result.req.user, "password"), false);
  assert.equal(JSON.stringify(result.req.user).includes("must-not-be-selected"), false);
});

test("valid administrator is authenticated with the current database role", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, (requestedId) => createUser(requestedId, "admin"));
  const result = await api.invoke(`Bearer ${createToken({ userId, role: "admin" })}`);

  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.req.user, { userId, role: "admin" });
  assert.equal(result.nextCalls, 1);
});

test("missing and malformed authorization headers are rejected without a lookup", async (t) => {
  const api = setup(t);
  for (const authorization of [undefined, "Basic abc", "Bearer", "Bearer ", "Bearer token extra"]) {
    const result = await api.invoke(authorization);
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalls, 0);
  }
  assert.deepEqual(api.lookups, []);
});

test("missing and non-Bearer credentials preserve the missing-token response", async (t) => {
  const api = setup(t);
  for (const authorization of [undefined, "Basic abc", "Bearer"]) {
    const result = await api.invoke(authorization);
    assert.deepEqual(result.res.body, {
      success: false,
      message: "Access denied. Authentication token is required.",
    });
  }
});

test("a missing Bearer token is rejected as an invalid token", async (t) => {
  const api = setup(t);
  assertInvalidAuthentication(await api.invoke("Bearer "));
  assert.deepEqual(api.lookups, []);
});

test("invalid JWT signatures preserve the invalid-token response and skip lookup", async (t) => {
  const api = setup(t);
  const userId = new mongoose.Types.ObjectId().toString();
  const token = jwt.sign({ userId }, OTHER_SECRET);
  const result = await api.invoke(`Bearer ${token}`);

  assertInvalidAuthentication(result);
  assert.deepEqual(api.lookups, []);
});

test("expired JWTs preserve the expired-token response and skip lookup", async (t) => {
  const api = setup(t);
  const userId = new mongoose.Types.ObjectId().toString();
  const token = createToken({ userId }, { expiresIn: -1 });
  const result = await api.invoke(`Bearer ${token}`);

  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, {
    success: false,
    message: "Authentication token has expired. Please log in again.",
  });
  assert.equal(result.nextCalls, 0);
  assert.deepEqual(api.lookups, []);
});

test("non-object JWT payloads are rejected before database access", async (t) => {
  const api = setup(t);
  const result = await api.invoke(`Bearer ${createToken("not-an-object")}`);

  assertInvalidAuthentication(result);
  assert.deepEqual(api.lookups, []);
});

test("missing, non-string, and invalid user IDs are rejected before database access", async (t) => {
  const api = setup(t);
  const payloads = [
    { role: "user" },
    { userId: 123 },
    { userId: "not-an-object-id" },
  ];

  for (const payload of payloads) {
    assertInvalidAuthentication(await api.invoke(`Bearer ${createToken(payload)}`));
  }
  assert.deepEqual(api.lookups, []);
});

test("nonexistent or deleted users are rejected", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, () => null);
  const result = await api.invoke(`Bearer ${createToken({ userId })}`);

  assertInvalidAuthentication(result);
  assert.deepEqual(api.lookups, [userId]);
});

test("unsupported and missing database roles are rejected", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  let user;
  const api = setup(t, () => user);
  for (user of [
    createUser(userId, "superadmin"),
    { _id: new mongoose.Types.ObjectId(userId) },
  ]) {
    assertInvalidAuthentication(await api.invoke(`Bearer ${createToken({ userId })}`));
  }
});

test("database connectivity failures return a generic 503 without calling next", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, () => {
    const error = new Error("private connection details");
    error.name = "MongoServerSelectionError";
    throw error;
  });
  const originalConsoleError = console.error;
  const logEntries = [];
  console.error = (...args) => logEntries.push(args);
  t.after(() => {
    console.error = originalConsoleError;
  });
  const result = await api.invoke(`Bearer ${createToken({ userId })}`);

  assert.equal(result.res.statusCode, 503);
  assert.deepEqual(result.res.body, {
    success: false,
    message: "Authentication service is temporarily unavailable. Please try again.",
  });
  assert.equal(JSON.stringify(result.res.body).includes("private connection details"), false);
  assert.equal(result.nextCalls, 0);
  assert.deepEqual(logEntries, [[
    "Authentication user lookup failed.",
    { category: "database_unavailable" },
  ]]);
});

test("unexpected database errors return a generic 500 without calling next", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, () => {
    throw new Error("private query details");
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });
  const result = await api.invoke(`Bearer ${createToken({ userId })}`);

  assert.equal(result.res.statusCode, 500);
  assert.deepEqual(result.res.body, {
    success: false,
    message: "Internal server error while authenticating.",
  });
  assert.equal(JSON.stringify(result.res.body).includes("private query details"), false);
  assert.equal(result.nextCalls, 0);
});

test("a stale administrator JWT cannot override the current user database role", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, (requestedId) => createUser(requestedId, "user"));
  const result = await api.invoke(`Bearer ${createToken({ userId, role: "admin" })}`);

  assert.deepEqual(result.req.user, { userId, role: "user" });
  assert.equal(result.nextCalls, 1);
});

test("a stale user JWT receives the current administrator database role", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, (requestedId) => createUser(requestedId, "admin"));
  const result = await api.invoke(`Bearer ${createToken({ userId, role: "user" })}`);

  assert.deepEqual(result.req.user, { userId, role: "admin" });
  assert.equal(result.nextCalls, 1);
});

test("a valid token without a role claim uses the database role", async (t) => {
  const userId = new mongoose.Types.ObjectId().toString();
  const api = setup(t, (requestedId) => createUser(requestedId, "user"));
  const result = await api.invoke(`Bearer ${createToken({ userId })}`);

  assert.deepEqual(result.req.user, { userId, role: "user" });
  assert.equal(result.nextCalls, 1);
});
