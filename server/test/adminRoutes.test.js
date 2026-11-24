import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createServer } from "node:http";
import User from "../models/User.js";
import authMiddleware from "../middleware/authMiddleware.js";
import adminRoutes from "../routes/adminRoutes.js";

const TEST_SECRET = "admin-routes-isolated-test-secret";
const ADMIN_ACCESS_DENIED = {
  success: false,
  message: "Access denied. Administrator privileges are required.",
};

function createToken(userId, role, options) {
  return jwt.sign({ userId, role }, TEST_SECRET, options);
}

async function createAdminApi(t, lookupUser = () => null) {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalConsoleError = console.error;
  const lookups = [];
  let broadRouterCalls = 0;
  process.env.JWT_SECRET = TEST_SECRET;
  console.error = () => {};
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
  app.use(express.json());
  app.use("/api/admin", adminRoutes);
  app.use("/api/admin", (req, res) => {
    res.status(404).json({ success: false, message: "Admin endpoint not found" });
  });
  app.use("/api", authMiddleware, (req, res) => {
    broadRouterCalls += 1;
    res.status(404).json({ success: false, message: "Not found" });
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    User.findById = originalFindById;
    console.error = originalConsoleError;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  return {
    lookups,
    get broadRouterCalls() {
      return broadRouterCalls;
    },
    async request({ token, path = "/api/admin/me", method = "GET", headers = {}, body } = {}) {
      const requestHeaders = { ...headers };
      if (token) requestHeaders.Authorization = `Bearer ${token}`;
      if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function validUserId() {
  return new mongoose.Types.ObjectId().toString();
}

function databaseUser(userId, role) {
  return {
    _id: new mongoose.Types.ObjectId(userId),
    role,
    email: "private@example.test",
    password: "private-password-hash",
    name: "Private Name",
    skills: ["private skill"],
  };
}

test("admin router requires a missing authentication token", async (t) => {
  const api = await createAdminApi(t);
  const response = await api.request();

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.deepEqual(api.lookups, []);
});

test("invalid and expired authentication tokens return 401", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "admin"));
  const invalid = await api.request({
    token: jwt.sign({ userId }, "different-isolated-secret"),
  });
  const expired = await api.request({
    token: createToken(userId, "admin", { expiresIn: -1 }),
  });

  assert.equal(invalid.status, 401);
  assert.equal(expired.status, 401);
  assert.deepEqual(api.lookups, []);
});

test("authenticated regular users receive 403", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "user"));
  const response = await api.request({ token: createToken(userId, "user") });

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, ADMIN_ACCESS_DENIED);
});

test("administrator identity response contains only userId and role with one lookup", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "admin"));
  const response = await api.request({ token: createToken(userId, "admin") });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    data: { userId, role: "admin" },
  });
  assert.deepEqual(Object.keys(response.body.data).sort(), ["role", "userId"]);
  assert.equal(JSON.stringify(response.body).includes("private"), false);
  assert.deepEqual(api.lookups, [userId]);
});

test("current database role overrides stale JWT role claims", async (t) => {
  const userId = validUserId();
  let currentRole = "user";
  const api = await createAdminApi(t, (id) => databaseUser(id, currentRole));
  const denied = await api.request({ token: createToken(userId, "admin") });
  assert.equal(denied.status, 403);

  currentRole = "admin";
  const allowed = await api.request({ token: createToken(userId, "user") });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.data, { userId, role: "admin" });
});

test("deleted users and unsupported database roles return 401", async (t) => {
  const userId = validUserId();
  const deletedUser = await createAdminApi(t, () => null);
  const deletedResponse = await deletedUser.request({
    token: createToken(userId, "admin"),
  });
  assert.equal(deletedResponse.status, 401);

  const unsupportedRole = await createAdminApi(t, (id) => databaseUser(id, "superadmin"));
  const unsupportedResponse = await unsupportedRole.request({
    token: createToken(userId, "admin"),
  });
  assert.equal(unsupportedResponse.status, 401);
});

test("database connectivity and unexpected failures prevent administrator access", async (t) => {
  const userId = validUserId();
  const unavailable = await createAdminApi(t, () => {
    const error = new Error("private connection detail");
    error.name = "MongoServerSelectionError";
    throw error;
  });
  const unavailableResponse = await unavailable.request({
    token: createToken(userId, "admin"),
  });
  assert.equal(unavailableResponse.status, 503);
  assert.equal(JSON.stringify(unavailableResponse.body).includes("private"), false);

  const failed = await createAdminApi(t, () => {
    throw new Error("private database detail");
  });
  const failedResponse = await failed.request({ token: createToken(userId, "admin") });
  assert.equal(failedResponse.status, 500);
  assert.equal(JSON.stringify(failedResponse.body).includes("private"), false);
});

test("headers, body, and query parameters cannot grant admin access", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "user"));
  const token = createToken(userId, "user");
  const attempts = [
    { token, path: "/api/admin/me?role=admin" },
    { token, headers: { role: "admin" } },
    { token, method: "POST", body: { role: "admin" } },
  ];

  for (const attempt of attempts) {
    const response = await api.request(attempt);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, ADMIN_ACCESS_DENIED);
  }
});

test("unauthorized requests do not reach the admin controller or broader API handlers", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "user"));
  const missing = await api.request();
  const regular = await api.request({
    token: createToken(userId, "user"),
  });

  assert.equal(missing.status, 401);
  assert.equal(regular.status, 403);
  assert.equal(Object.hasOwn(regular.body, "data"), false);
  assert.equal(api.broadRouterCalls, 0);
});

test("unknown admin paths are authorized before the broad API fallback and do not duplicate lookups", async (t) => {
  const userId = validUserId();
  const api = await createAdminApi(t, (id) => databaseUser(id, "admin"));
  const response = await api.request({
    token: createToken(userId, "admin"),
    path: "/api/admin/unknown",
  });

  assert.equal(response.status, 404);
  assert.equal(api.broadRouterCalls, 0);
  assert.deepEqual(api.lookups, [userId]);
});

test("production server registers the admin router and its fallback before the broad /api router", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const adminMount = source.indexOf('app.use("/api/admin", adminRoutes);');
  const adminFallback = source.indexOf('app.use("/api/admin", (req, res) => {');
  const mockSessionMount = source.indexOf('app.use("/api", mockSessionRoutes);');

  assert.ok(source.includes('import adminRoutes from "./routes/adminRoutes.js";'));
  assert.notEqual(adminMount, -1);
  assert.notEqual(adminFallback, -1);
  assert.notEqual(mockSessionMount, -1);
  assert.ok(adminMount < adminFallback);
  assert.ok(adminFallback < mockSessionMount);
});
