import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import User from "../models/User.js";

const TEST_SECRET = "require-admin-isolated-test-secret";
const AUTHENTICATION_REQUIRED = {
  success: false,
  message: "Authentication is required.",
};
const ADMIN_ACCESS_DENIED = {
  success: false,
  message: "Access denied. Administrator privileges are required.",
};

function createResponse() {
  return {
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
}

async function invokeMiddleware(user, requestOverrides = {}) {
  const req = {
    user,
    headers: {},
    body: {},
    query: {},
    ...requestOverrides,
  };
  const res = createResponse();
  let nextCalls = 0;
  requireAdmin(req, res, () => {
    nextCalls += 1;
  });
  return { req, res, nextCalls };
}

function validUserId() {
  return new mongoose.Types.ObjectId().toString();
}

function createToken(payload, options) {
  return jwt.sign(payload, TEST_SECRET, options);
}

async function createProtectedApi(t, lookupUser) {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const lookups = [];
  let protectedHandlerCalls = 0;
  process.env.JWT_SECRET = TEST_SECRET;
  User.findById = (userId) => {
    lookups.push(String(userId));
    return {
      select() {
        return this;
      },
      lean() {
        return Promise.resolve().then(() => lookupUser(String(userId)));
      },
    };
  };

  const app = express();
  app.get(
    "/protected",
    authMiddleware,
    requireAdmin,
    (req, res) => {
      protectedHandlerCalls += 1;
      res.status(200).json({ success: true, userId: req.user.userId });
    },
  );
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    User.findById = originalFindById;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  return {
    lookups,
    get protectedHandlerCalls() {
      return protectedHandlerCalls;
    },
    async request({ token, authorization, body } = {}) {
      const headers = {};
      if (authorization !== undefined) headers.Authorization = authorization;
      else if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/protected`,
        {
          method: body === undefined ? "GET" : "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test("valid authenticated administrator is allowed exactly once", async () => {
  const result = await invokeMiddleware({ userId: validUserId(), role: "admin" });

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.res.body, undefined);
});

test("valid authenticated regular user is denied", async () => {
  const result = await invokeMiddleware({ userId: validUserId(), role: "user" });

  assert.equal(result.res.statusCode, 403);
  assert.deepEqual(result.res.body, ADMIN_ACCESS_DENIED);
  assert.equal(result.nextCalls, 0);
});

test("missing and null authenticated users are rejected", async () => {
  for (const user of [undefined, null]) {
    const result = await invokeMiddleware(user);
    assert.equal(result.res.statusCode, 401);
    assert.deepEqual(result.res.body, AUTHENTICATION_REQUIRED);
    assert.equal(result.nextCalls, 0);
  }
});

test("missing and invalid user IDs are rejected as unauthenticated", async () => {
  for (const user of [
    { role: "admin" },
    { userId: "not-an-object-id", role: "admin" },
    { userId: new mongoose.Types.ObjectId(), role: "admin" },
  ]) {
    const result = await invokeMiddleware(user);
    assert.equal(result.res.statusCode, 401);
    assert.deepEqual(result.res.body, AUTHENTICATION_REQUIRED);
    assert.equal(result.nextCalls, 0);
  }
});

test("missing, unknown, and incorrectly capitalized roles are denied", async () => {
  for (const role of [undefined, "unknown", "Admin"]) {
    const user = { userId: validUserId() };
    if (role !== undefined) user.role = role;
    const result = await invokeMiddleware(user);
    assert.equal(result.res.statusCode, 403);
    assert.deepEqual(result.res.body, ADMIN_ACCESS_DENIED);
    assert.equal(result.nextCalls, 0);
  }
});

test("body, headers, and query parameters cannot grant administrator access", async () => {
  const attempts = [
    { body: { role: "admin" } },
    { headers: { role: "admin" } },
    { query: { role: "admin" } },
  ];

  for (const overrides of attempts) {
    const result = await invokeMiddleware(
      { userId: validUserId(), role: "user" },
      overrides,
    );
    assert.equal(result.res.statusCode, 403);
    assert.deepEqual(result.res.body, ADMIN_ACCESS_DENIED);
    assert.equal(result.nextCalls, 0);
  }
});

test("rejected responses contain only generic messages", async () => {
  const sensitiveUserId = validUserId();
  const results = [
    await invokeMiddleware(undefined),
    await invokeMiddleware({ userId: sensitiveUserId, role: "user" }),
  ];

  for (const result of results) {
    const serialized = JSON.stringify(result.res.body);
    assert.equal(serialized.includes(sensitiveUserId), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("token"), false);
  }
});

test("HTTP request without a JWT returns 401 without reaching the handler", async (t) => {
  const api = await createProtectedApi(t, () => null);
  const response = await api.request();

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.equal(api.protectedHandlerCalls, 0);
  assert.deepEqual(api.lookups, []);
});

test("invalid and expired JWTs return 401 without reaching the handler", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, (requestedId) => ({
    _id: new mongoose.Types.ObjectId(requestedId),
    role: "admin",
  }));
  const invalid = await api.request({
    token: jwt.sign({ userId }, "different-isolated-secret"),
  });
  const expired = await api.request({
    token: createToken({ userId }, { expiresIn: -1 }),
  });

  assert.equal(invalid.status, 401);
  assert.equal(expired.status, 401);
  assert.equal(api.protectedHandlerCalls, 0);
  assert.deepEqual(api.lookups, []);
});

test("valid regular-user JWT returns 403 without reaching the handler", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, (requestedId) => ({
    _id: new mongoose.Types.ObjectId(requestedId),
    role: "user",
  }));
  const response = await api.request({ token: createToken({ userId, role: "user" }) });

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, ADMIN_ACCESS_DENIED);
  assert.equal(api.protectedHandlerCalls, 0);
});

test("valid administrator JWT with current database administrator role succeeds", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, (requestedId) => ({
    _id: new mongoose.Types.ObjectId(requestedId),
    role: "admin",
  }));
  const response = await api.request({ token: createToken({ userId, role: "admin" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, userId });
  assert.equal(api.protectedHandlerCalls, 1);
});

test("current database administrator role allows access regardless of JWT role", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, (requestedId) => ({
    _id: new mongoose.Types.ObjectId(requestedId),
    role: "admin",
  }));
  const response = await api.request({ token: createToken({ userId, role: "user" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, userId });
  assert.equal(api.protectedHandlerCalls, 1);
  assert.deepEqual(api.lookups, [userId]);
});

test("stale administrator JWT role cannot override the current regular database role", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, (requestedId) => ({
    _id: new mongoose.Types.ObjectId(requestedId),
    role: "user",
  }));
  const response = await api.request({ token: createToken({ userId, role: "admin" }) });

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, ADMIN_ACCESS_DENIED);
  assert.equal(api.protectedHandlerCalls, 0);
});

test("deleted users return 401 without reaching the handler", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, () => null);
  const response = await api.request({ token: createToken({ userId, role: "admin" }) });

  assert.equal(response.status, 401);
  assert.equal(api.protectedHandlerCalls, 0);
});

test("database connectivity failures return 503 without reaching the handler", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, () => {
    const error = new Error("private database connection detail");
    error.name = "MongoServerSelectionError";
    throw error;
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });
  const response = await api.request({ token: createToken({ userId }) });

  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes("private database"), false);
  assert.equal(api.protectedHandlerCalls, 0);
});

test("unexpected database failures return 500 without reaching the handler", async (t) => {
  const userId = validUserId();
  const api = await createProtectedApi(t, () => {
    throw new Error("private query detail");
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });
  const response = await api.request({ token: createToken({ userId }) });

  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes("private query"), false);
  assert.equal(api.protectedHandlerCalls, 0);
});
