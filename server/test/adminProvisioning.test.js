import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import bcrypt from "bcrypt";
import { fileURLToPath } from "node:url";
import {
  ProvisioningError,
  UNCERTAIN_CREATION_MESSAGE,
  normalizeEmail,
  provisionAdministrator,
  validateAdministratorInput,
} from "../services/adminProvisioningService.js";
import {
  connectAndProvision,
  generateConfirmationChallenge,
  getDatabaseTarget,
  getSanitizedDatabaseTarget,
  readHiddenInput,
  readVisibleInput,
  run,
  verifyConnectedServer,
  verifyStoredEmailsNormalized,
  verifyUserEmailIndex,
} from "../scripts/createAdmin.js";

const TEST_URI = "mongodb://private-user:private-password@localhost:27017/ai_interview_platform";
const TARGET = "localhost:27017/ai_interview_platform";
const validInput = {
  name: "  Admin User  ",
  email: "  Admin.User@Example.COM ",
  password: "Correct Horse Battery",
  passwordConfirmation: "Correct Horse Battery",
};

function createUserModel(existing = null, onCreate) {
  const calls = { find: [], create: [] };
  return {
    calls,
    findOne(query) {
      calls.find.push(query);
      return {
        lean: async () => {
          if (typeof existing === "function") return existing();
          return existing;
        },
      };
    },
    async create(document) {
      calls.create.push(document);
      if (onCreate) return onCreate(document);
      return { _id: "507f1f77bcf86cd799439011", ...document };
    },
  };
}

class FakeTerminal extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawModes = [];
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {}
  pause() {}
}

class ScriptedTerminal extends FakeTerminal {
  constructor(cancelAtResume) {
    super();
    this.cancelAtResume = cancelAtResume;
    this.resumeCount = 0;
    this.pauseCount = 0;
    this.pendingInterval = null;
  }

  resume() {
    this.resumeCount += 1;
    if (!this.pendingInterval) this.pendingInterval = setInterval(() => {}, 1000);
    if (this.resumeCount === this.cancelAtResume) {
      this.emit("data", Buffer.from("\x03"));
    } else {
      const inputs = [
        "Disposable Check\r",
        "manual-check@example.invalid\r",
        "DummyPassphrase-123\r",
        "DummyPassphrase-123\r",
        "unused-final-confirmation\r",
      ];
      const data = inputs[this.resumeCount - 1];
      setImmediate(() => this.emit("data", Buffer.from(data)));
    }
  }

  pause() {
    this.pauseCount += 1;
    if (this.pendingInterval) clearInterval(this.pendingInterval);
    this.pendingInterval = null;
  }
}

function createOutput(tty = true) {
  return {
    isTTY: tty,
    text: "",
    write(value) {
      this.text += value;
    },
  };
}

function createFakeMongoose({
  actualName = "ai_interview_platform",
  address = "localhost:27017",
  serverType = "Standalone",
  indexes = [{ key: { email: 1 }, unique: true }],
  storedEmails = [],
  onConnect,
  onListIndexes,
  onFindEmails,
  onDisconnect,
} = {}) {
  const calls = { connect: [], disconnect: 0 };
  const fake = {
    calls,
    connection: {
      db: {
        databaseName: actualName,
        collection() {
          return {
            listIndexes: () => ({
              toArray: async () => {
                if (onListIndexes) await onListIndexes();
                return indexes;
              },
            }),
            find() {
              return {
                async *[Symbol.asyncIterator]() {
                  if (onFindEmails) await onFindEmails();
                  for (const email of storedEmails) yield { email };
                },
                async close() {},
              };
            },
          };
        },
      },
      getClient() {
        return {
          topology: {
            description: {
              servers: new Map([[address, { type: serverType }]]),
            },
          },
        };
      },
    },
    async connect(uri, options) {
      calls.connect.push({ uri, options });
      if (onConnect) await onConnect();
    },
    async disconnect() {
      calls.disconnect += 1;
      if (onDisconnect) await onDisconnect();
    },
  };
  return fake;
}

class FakeProcess extends EventEmitter {
  constructor(argv = ["node", "createAdmin.js"]) {
    super();
    this.argv = argv;
    this.exitCode = undefined;
  }
}

function createRunDependencies(overrides = {}) {
  const runtimeProcess = overrides.process || new FakeProcess();
  const output = createOutput(true);
  const errors = createOutput(false);
  const visibleInputs = ["Admin User", "admin@example.com"];
  return {
    process: runtimeProcess,
    argv: runtimeProcess.argv,
    stdin: { isTTY: true },
    stdout: output,
    stderr: errors,
    environment: { MONGO_URI: TEST_URI },
    loadEnvironment() {},
    readVisibleInput: async () => visibleInputs.shift() || "",
    generateChallenge: () => "fresh-test-challenge",
    readHiddenInput: async (question) =>
      question.startsWith("Final authorization")
        ? `CREATE ADMIN IN ${TARGET} CONFIRM fresh-test-challenge`
        : "Correct Horse Battery",
    connectAndProvision: async () => ({
      id: "safe-id",
      name: "Admin User",
      email: "admin.user@example.com",
      role: "admin",
      cleanupSucceeded: true,
    }),
    ...overrides,
    output,
    errors,
  };
}

test("valid administrator details are normalized and trimmed", () => {
  assert.deepEqual(validateAdministratorInput(validInput), {
    name: "Admin User",
    email: "admin.user@example.com",
    password: "Correct Horse Battery",
  });
});

test("validation rejects missing name, email, password, and invalid email", () => {
  const cases = [
    { ...validInput, name: " " },
    { ...validInput, email: " " },
    { ...validInput, email: "invalid-email" },
    { ...validInput, password: "" },
  ];
  for (const input of cases) {
    assert.throws(
      () => validateAdministratorInput(input),
      (error) => error instanceof ProvisioningError && error.category === "VALIDATION",
    );
  }
});

test("email normalization trims and lowercases", () => {
  assert.equal(normalizeEmail("  Test@Example.COM "), "test@example.com");
});

test("passwords preserve whitespace and support Unicode", () => {
  const password = "  密码密码密码密码密码密码  ";
  const result = validateAdministratorInput({
    name: "Admin",
    email: "admin@example.com",
    password,
    passwordConfirmation: password,
  });
  assert.equal(result.password, password);
});

test("password requires 12 characters and rejects more than 72 UTF-8 bytes", () => {
  assert.throws(() => validateAdministratorInput({
    name: "Admin",
    email: "admin@example.com",
    password: "12345678901",
    passwordConfirmation: "12345678901",
  }));
  assert.throws(() => validateAdministratorInput({
    name: "Admin",
    email: "admin@example.com",
    password: "é".repeat(37),
    passwordConfirmation: "é".repeat(37),
  }));
  assert.doesNotThrow(() => validateAdministratorInput({
    name: "Admin",
    email: "admin@example.com",
    password: "密".repeat(12),
    passwordConfirmation: "密".repeat(12),
  }));
});

test("password confirmation must match exactly", () => {
  assert.throws(
    () => validateAdministratorInput({ ...validInput, passwordConfirmation: " other password " }),
  );
});

test("successful provisioning creates an admin with a bcrypt cost-12 hash", async () => {
  const model = createUserModel();
  const result = await provisionAdministrator(validInput, { UserModel: model });
  assert.equal(model.calls.find[0].email, "admin.user@example.com");
  assert.equal(model.calls.create.length, 1);
  assert.equal(model.calls.create[0].role, "admin");
  assert.notEqual(model.calls.create[0].password, validInput.password);
  assert.equal(await bcrypt.compare(validInput.password, model.calls.create[0].password), true);
  assert.equal(model.calls.create[0].password.length, 60);
  assert.equal(result.role, "admin");
  assert.equal(result.lifecycle.accountCreation, "confirmed_success");
  assert.equal("password" in result, false);
  assert.equal("passwordHash" in result, false);
});

test("existing regular-user and administrator emails are rejected without writes", async () => {
  for (const role of ["user", "admin"]) {
    const model = createUserModel({ _id: "existing", role });
    await assert.rejects(
      provisionAdministrator(validInput, { UserModel: model }),
      (error) => error.category === "DUPLICATE_ACCOUNT",
    );
    assert.equal(model.calls.create.length, 0);
  }
});

test("duplicate-key race is definitive and does not update or retry", async () => {
  const model = createUserModel(null, async () => {
    const error = new Error("private database detail");
    error.code = 11000;
    throw error;
  });
  const lifecycle = { accountCreation: "not_started" };
  await assert.rejects(
    provisionAdministrator(validInput, { UserModel: model, lifecycle }),
    (error) => error.category === "DUPLICATE_ACCOUNT" && !error.message.includes("private"),
  );
  assert.equal(lifecycle.accountCreation, "definitively_rejected");
  assert.equal(model.calls.create.length, 1);
  assert.equal("updateOne" in model, false);
  assert.equal("findOneAndUpdate" in model, false);
});

test("ambiguous create failure is marked uncertain and is never retried or deleted", async () => {
  const model = createUserModel(null, async () => {
    throw new Error("private network and URI detail");
  });
  const lifecycle = { accountCreation: "not_started" };
  await assert.rejects(
    provisionAdministrator(validInput, { UserModel: model, lifecycle }),
    (error) => error.category === "OUTCOME_UNCERTAIN" && error.message === UNCERTAIN_CREATION_MESSAGE,
  );
  assert.equal(lifecycle.accountCreation, "outcome_uncertain");
  assert.equal(model.calls.create.length, 1);
  assert.equal("deleteOne" in model, false);
});

test("cancellation after create starts but confirmed success remains a confirmed outcome", async () => {
  const controller = new AbortController();
  const model = createUserModel(null, async (document) => {
    controller.abort();
    return { _id: "confirmed-id", ...document };
  });
  const lifecycle = { accountCreation: "not_started" };
  const result = await provisionAdministrator(validInput, {
    UserModel: model,
    lifecycle,
    signal: controller.signal,
  });
  assert.equal(result.id, "confirmed-id");
  assert.equal(lifecycle.accountCreation, "confirmed_success");
  assert.equal(model.calls.create.length, 1);
});

test("database target requires a single direct MongoDB endpoint and database", () => {
  assert.deepEqual(getDatabaseTarget(TEST_URI), {
    databaseName: "ai_interview_platform",
    host: "localhost:27017",
    protocol: "mongodb:",
    topology: "single-host-standalone",
  });
  assert.equal(getSanitizedDatabaseTarget(TEST_URI), TARGET);
  assert.equal(getDatabaseTarget("mongodb://localhost"), null);
  assert.equal(getDatabaseTarget("mongodb://localhost/db/extra"), null);
  assert.equal(getDatabaseTarget("mongodb://host1,host2/db"), null);
  assert.equal(getDatabaseTarget("mongodb+srv://cluster.example/db"), null);
  assert.equal(getDatabaseTarget("mongodb://localhost/db?replicaSet=rs0"), null);
  assert.equal(getDatabaseTarget("postgres://localhost/db"), null);
});

test("sanitized targets never expose URI credentials", () => {
  const target = getSanitizedDatabaseTarget(TEST_URI);
  assert.equal(target, TARGET);
  assert.equal(target.includes("private-user"), false);
  assert.equal(target.includes("private-password"), false);
});

test("confirmation challenges are fresh, cryptographically sized values", () => {
  const first = generateConfirmationChallenge();
  const second = generateConfirmationChallenge();
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.match(second, /^[0-9a-f]{48}$/);
  assert.notEqual(first, second);
});

test("connected server verification accepts only the confirmed standalone endpoint", () => {
  const target = getDatabaseTarget(TEST_URI);
  assert.equal(verifyConnectedServer(target, {
    servers: new Map([["localhost:27017", { type: "Standalone" }]]),
  }), true);
  assert.equal(verifyConnectedServer(target, {
    servers: new Map([["other-host:27017", { type: "Standalone" }]]),
  }), false);
  assert.equal(verifyConnectedServer(target, {
    servers: new Map([["localhost:27017", { type: "RSPrimary" }]]),
  }), false);
  assert.equal(verifyConnectedServer(target, {
    servers: new Map([
      ["localhost:27017", { type: "RSPrimary" }],
      ["other-host:27017", { type: "RSSecondary" }],
    ]),
  }), false);
});

test("email index verification rejects sparse, partial, compound, and non-simple collation indexes", () => {
  assert.equal(verifyUserEmailIndex([{ key: { email: 1 }, unique: true }]), true);
  assert.equal(verifyUserEmailIndex([{ key: { email: 1 }, unique: true, sparse: true }]), false);
  assert.equal(verifyUserEmailIndex([{
    key: { email: 1 },
    unique: true,
    partialFilterExpression: { role: "admin" },
  }]), false);
  assert.equal(verifyUserEmailIndex([{
    key: { email: 1 },
    unique: true,
    collation: { locale: "en", strength: 2 },
  }]), false);
  assert.equal(verifyUserEmailIndex([{ key: { email: 1, role: 1 }, unique: true }]), false);
  assert.equal(verifyUserEmailIndex([{ key: { _id: 1 }, unique: true }]), false);
});

test("stored emails must already match trim-and-lowercase normalization", async () => {
  const collection = {
    find() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { email: "admin@example.com" };
          yield { email: " Admin@Example.com " };
        },
        async close() {},
      };
    },
  };
  assert.equal(await verifyStoredEmailsNormalized({
    find() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { email: "admin@example.com" };
        },
        async close() {},
      };
    },
  }), true);
  assert.equal(await verifyStoredEmailsNormalized(collection), false);
});

test("hidden input remains hidden and supports Unicode backspace", async () => {
  const input = new FakeTerminal();
  const output = createOutput();
  const reading = readHiddenInput(
    "Password: ",
    input,
    output,
    undefined,
    () => {},
    { quietPeriodMs: 5 },
  );
  input.emit("data", Buffer.from("密码ab\x7f\r\n"));
  assert.equal(await reading, "密码a");
  assert.equal(output.text.includes("密码"), false);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

test("multiline hidden paste is rejected without echo or spillover", async () => {
  const input = new FakeTerminal();
  const output = createOutput();
  const reading = readHiddenInput(
    "Password: ",
    input,
    output,
    undefined,
    () => {},
    { quietPeriodMs: 5 },
  );
  input.emit("data", Buffer.from("secret-password\r\nCREATE ADMIN"));
  await assert.rejects(reading, (error) => error.category === "MULTILINE_INPUT");
  assert.equal(output.text.includes("secret-password"), false);
  assert.equal(output.text.includes("CREATE ADMIN"), false);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
});

test("multiline password paste cannot reach a later visible CLI prompt", async () => {
  const terminal = new FakeTerminal();
  const terminalOutput = createOutput();
  let visibleCalls = 0;
  let connectCalls = 0;
  const dependencies = createRunDependencies({
    readVisibleInput: async () => {
      visibleCalls += 1;
      return visibleCalls === 1 ? "Admin User" : "admin@example.com";
    },
    readHiddenInput: async (question) => {
      const reading = readHiddenInput(
        question,
        terminal,
        terminalOutput,
        undefined,
        () => {},
        { quietPeriodMs: 5 },
      );
      terminal.emit("data", Buffer.from("password-secret\r\nCREATE ADMIN"));
      return reading;
    },
    connectAndProvision: async () => { connectCalls += 1; },
  });
  assert.equal(await run(dependencies), 1);
  assert.equal(visibleCalls, 2);
  assert.equal(connectCalls, 0);
  assert.equal(terminalOutput.text.includes("password-secret"), false);
  assert.equal(dependencies.errors.text.includes("Multi-line pasted input"), true);
});

test("delayed password paste during password confirmation remains hidden", async () => {
  const terminal = new FakeTerminal();
  const output = createOutput();
  const firstPrompt = readHiddenInput("Password: ", terminal, output);
  terminal.emit("data", Buffer.from("FirstPassword-123\r"));
  setTimeout(() => terminal.emit("data", Buffer.from("delayed-secret\r")), 275);
  assert.equal(await firstPrompt, "FirstPassword-123");

  const confirmationPrompt = readHiddenInput("Confirm password: ", terminal, output);
  assert.equal(await confirmationPrompt, "delayed-secret");
  assert.equal(output.text.includes("delayed-secret"), false);
  assert.equal(terminal.isRaw, false);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("delayed password paste during final authorization remains hidden and cannot authorize", async () => {
  const terminal = new FakeTerminal();
  const terminalOutput = createOutput();
  let hiddenCalls = 0;
  let connections = 0;
  const dependencies = createRunDependencies({
    generateChallenge: () => "new-challenge",
    readHiddenInput: async (question) => {
      hiddenCalls += 1;
      const reading = readHiddenInput(question, terminal, terminalOutput);
      if (hiddenCalls < 3) {
        terminal.emit("data", Buffer.from("Correct Horse Battery\r"));
        if (hiddenCalls === 2) {
          setTimeout(
            () => terminal.emit("data", Buffer.from(`CREATE ADMIN IN ${TARGET} CONFIRM old-challenge\r`)),
            275,
          );
        }
      }
      return reading;
    },
    connectAndProvision: async () => { connections += 1; },
  });
  assert.equal(await run(dependencies), 1);
  assert.equal(hiddenCalls, 3);
  assert.equal(connections, 0);
  assert.equal(terminalOutput.text.includes("old-challenge"), false);
  assert.equal(dependencies.output.text.includes("old-challenge"), false);
  assert.equal(terminal.isRaw, false);
  assert.equal(terminal.listenerCount("data"), 0);
});

test("visible input cancellation restores terminal mode and removes listeners", async () => {
  const input = new FakeTerminal();
  const output = createOutput();
  const controller = new AbortController();
  let abortListenersAdded = 0;
  let abortListenersRemoved = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) {
      abortListenersAdded += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      abortListenersRemoved += 1;
      controller.signal.removeEventListener(...args);
    },
  };
  const reading = readVisibleInput(
    "Name: ",
    input,
    output,
    signal,
    () => controller.abort(),
    { quietPeriodMs: 5 },
  );
  input.emit("data", Buffer.from("Admin"));
  controller.abort();
  await assert.rejects(reading, (error) => error.category === "CANCELLED");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(abortListenersAdded, 1);
  assert.equal(abortListenersRemoved, 1);
});

test("cancellation clears a pending quiet-period timer", async () => {
  const input = new FakeTerminal();
  const output = createOutput();
  const controller = new AbortController();
  const pendingTimers = new Set();
  const timers = {
    setTimeout(callback) {
      const handle = { callback };
      pendingTimers.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      pendingTimers.delete(handle);
    },
  };
  const reading = readVisibleInput(
    "Name: ",
    input,
    output,
    controller.signal,
    () => controller.abort(),
    { timers },
  );
  input.emit("data", Buffer.from("Disposable Check\r"));
  assert.equal(pendingTimers.size, 1);
  controller.abort();
  await assert.rejects(reading, (error) => error.category === "CANCELLED");
  assert.equal(pendingTimers.size, 0);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, false);
});

test("visible prompts reject non-interactive terminals", async () => {
  await assert.rejects(
    readVisibleInput("Name: ", { isTTY: false }, createOutput(false)),
    (error) => error.category === "TERMINAL",
  );
});

test("CLI rejects non-interactive execution and unexpected arguments", async () => {
  const nonInteractive = createRunDependencies({ stdin: { isTTY: false } });
  assert.equal(await run(nonInteractive), 1);
  const unexpected = createRunDependencies({ argv: ["node", "createAdmin.js", "secret"] });
  assert.equal(await run(unexpected), 1);
});

test("CLI rejects missing or unsupported database configuration", async () => {
  const missing = createRunDependencies({ environment: {} });
  assert.equal(await run(missing), 1);
  const unsupported = createRunDependencies({
    environment: { MONGO_URI: "mongodb+srv://cluster.example/ai_interview_platform" },
  });
  assert.equal(await run(unsupported), 1);
});

test("incorrect or host-incomplete confirmation prevents connection", async () => {
  let connectCalls = 0;
  const dependencies = createRunDependencies({
    generateChallenge: () => "expected-challenge",
    readHiddenInput: async (prompt) =>
      prompt.startsWith("Final authorization")
        ? `CREATE ADMIN IN ${TARGET}`
        : "Correct Horse Battery",
    connectAndProvision: async () => { connectCalls += 1; },
  });
  assert.equal(await run(dependencies), 1);
  assert.equal(connectCalls, 0);
  assert.match(dependencies.output.text, /CREATE ADMIN IN localhost:27017\/ai_interview_platform CONFIRM expected-challenge/);
});

test("stale confirmation challenge is rejected without connecting", async () => {
  let connections = 0;
  const dependencies = createRunDependencies({
    generateChallenge: () => "current-challenge",
    readHiddenInput: async (prompt) =>
      prompt.startsWith("Final authorization")
        ? `CREATE ADMIN IN ${TARGET} CONFIRM previous-challenge`
        : "Correct Horse Battery",
    connectAndProvision: async () => { connections += 1; },
  });
  assert.equal(await run(dependencies), 1);
  assert.equal(connections, 0);
  assert.equal(dependencies.errors.text.includes("No database connection was made"), true);
});

test("each provisioning attempt gets a fresh challenge after both passwords", async () => {
  const challenges = ["attempt-one", "attempt-two"];
  const displayed = [];
  let hiddenCalls = 0;
  let connectionCalls = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const dependencies = createRunDependencies({
      generateChallenge: () => {
        assert.equal(hiddenCalls, 2);
        const challenge = challenges.shift();
        displayed.push(challenge);
        return challenge;
      },
      readHiddenInput: async (prompt) => {
        hiddenCalls += 1;
        if (prompt.startsWith("Final authorization")) {
          return `CREATE ADMIN IN ${TARGET} CONFIRM ${displayed[displayed.length - 1]}`;
        }
        return "Correct Horse Battery";
      },
      connectAndProvision: async () => {
        connectionCalls += 1;
        return {
          id: "safe-id",
          role: "admin",
          cleanupSucceeded: true,
        };
      },
    });
    assert.equal(await run(dependencies), 0);
    hiddenCalls = 0;
  }
  assert.deepEqual(displayed, ["attempt-one", "attempt-two"]);
  assert.equal(connectionCalls, 2);
});

test("no connection occurs until exact endpoint, database, and challenge confirmation", async () => {
  let confirmedTarget;
  const dependencies = createRunDependencies({
    generateChallenge: () => "correct-challenge",
    readHiddenInput: async (prompt) =>
      prompt.startsWith("Final authorization")
        ? `CREATE ADMIN IN ${TARGET} CONFIRM correct-challenge`
        : "Correct Horse Battery",
    connectAndProvision: async (options) => {
      confirmedTarget = options.confirmedTarget;
      return {
        id: "safe-id",
        name: "Admin User",
        email: "admin@example.com",
        role: "admin",
        cleanupSucceeded: true,
      };
    },
  });
  assert.equal(await run(dependencies), 0);
  assert.equal(confirmedTarget, TARGET);
  assert.equal(dependencies.output.text.includes("private-password"), false);
  assert.equal(dependencies.output.text.includes("Correct Horse Battery"), false);
  assert.equal(dependencies.output.text.includes("Admin User"), false);
  assert.equal(dependencies.errors.text, "");
});

test("cancellation during visible input and final hidden confirmation returns 130", async () => {
  const visibleProcess = new FakeProcess();
  const visible = createRunDependencies({
    process: visibleProcess,
    readVisibleInput: async () => {
      visibleProcess.emit("SIGINT");
      return "";
    },
  });
  assert.equal(await run(visible), 130);
  assert.equal(visibleProcess.listenerCount("SIGINT"), 0);

  const finalProcess = new FakeProcess();
  let hiddenCalls = 0;
  let connectCalls = 0;
  const finalConfirmation = createRunDependencies({
    process: finalProcess,
    readHiddenInput: async (prompt) => {
      hiddenCalls += 1;
      if (hiddenCalls === 3) finalProcess.emit("SIGINT");
      return prompt.startsWith("Final authorization")
        ? "arbitrary-cancelled-input"
        : "Correct Horse Battery";
    },
    connectAndProvision: async () => { connectCalls += 1; },
  });
  assert.equal(await run(finalConfirmation), 130);
  assert.equal(finalConfirmation.errors.text.includes("cancelled"), true);
  assert.equal(connectCalls, 0);
});

test("cancellation at every sequential prompt cleans input and process listeners", async () => {
  for (let cancelAt = 1; cancelAt <= 5; cancelAt += 1) {
    const input = new ScriptedTerminal(cancelAt);
    const runtimeProcess = new FakeProcess();
    let connectCalls = 0;
    const dependencies = createRunDependencies({
      process: runtimeProcess,
      stdin: input,
      readVisibleInput: undefined,
      readHiddenInput: undefined,
      connectAndProvision: async () => { connectCalls += 1; },
    });

    assert.equal(await run(dependencies), 130, `prompt ${cancelAt}`);
    assert.equal(input.isRaw, false, `raw mode at prompt ${cancelAt}`);
    assert.equal(input.listenerCount("data"), 0, `data listener at prompt ${cancelAt}`);
    assert.equal(input.listenerCount("error"), 0, `error listener at prompt ${cancelAt}`);
    assert.equal(input.listenerCount("end"), 0, `end listener at prompt ${cancelAt}`);
    assert.equal(runtimeProcess.listenerCount("SIGINT"), 0, `SIGINT listener at prompt ${cancelAt}`);
    assert.equal(input.pendingInterval, null, `active stdin at prompt ${cancelAt}`);
    assert.equal(connectCalls, 0);
  }
});

test("child process exits naturally after cancellation on a subsequent prompt", () => {
  const serverDirectory = fileURLToPath(new URL("../", import.meta.url));
  const script = `
    import { EventEmitter } from "node:events";
    import { run } from "./scripts/createAdmin.js";
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      resumes = 0;
      keepAlive;
      setRawMode(value) { this.isRaw = value; }
      resume() {
        this.resumes += 1;
        if (!this.keepAlive) this.keepAlive = setInterval(() => {}, 1000);
        if (this.resumes === 1) {
          setTimeout(() => this.emit("data", Buffer.from("Disposable Check\\r")), 10);
        } else if (this.resumes === 2) {
          this.emit("data", Buffer.from("\\x03"));
        }
      }
      pause() {
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.keepAlive = undefined;
      }
    }
    const input = new Input();
    const output = { isTTY: true, write() {} };
    const code = await run({
      process,
      argv: ["node", "createAdmin.js"],
      stdin: input,
      stdout: output,
      stderr: output,
      environment: { MONGO_URI: "mongodb://localhost:27017/ai_interview_platform" },
      loadEnvironment() {},
    });
    process.exitCode = code;
    console.log("cancellation=" + code + "; raw=" + input.isRaw + "; listeners=" + input.listenerCount("data"));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: serverDirectory, encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 130, child.stderr);
  assert.match(child.stdout, /cancellation=130; raw=false; listeners=0/);
});

test("cancellation during password confirmation prevents target confirmation and connection", async () => {
  const runtimeProcess = new FakeProcess();
  let visibleCalls = 0;
  let hiddenCalls = 0;
  let connectCalls = 0;
  const dependencies = createRunDependencies({
    process: runtimeProcess,
    readVisibleInput: async () => {
      visibleCalls += 1;
      return visibleCalls === 1 ? "Admin User" : "admin@example.com";
    },
    readHiddenInput: async () => {
      hiddenCalls += 1;
      if (hiddenCalls === 2) runtimeProcess.emit("SIGINT");
      return "Correct Horse Battery";
    },
    connectAndProvision: async () => { connectCalls += 1; },
  });
  assert.equal(await run(dependencies), 130);
  assert.equal(visibleCalls, 2);
  assert.equal(hiddenCalls, 2);
  assert.equal(connectCalls, 0);
  assert.equal(runtimeProcess.listenerCount("SIGINT"), 0);
});

test("hidden prompt Ctrl+C cancellation restores mode and returns exit code 130", async () => {
  const input = new FakeTerminal();
  const output = createOutput();
  const controller = new AbortController();
  const reading = readHiddenInput(
    "Password: ",
    input,
    output,
    controller.signal,
    () => controller.abort(),
    { quietPeriodMs: 5 },
  );
  input.emit("data", Buffer.from("\x03"));
  await assert.rejects(reading, (error) => error.category === "CANCELLED");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
});

test("connected database or server mismatch prevents account creation", async () => {
  for (const fake of [
    createFakeMongoose({ actualName: "different_database" }),
    createFakeMongoose({ address: "different-host:27017" }),
  ]) {
    const model = createUserModel();
    await assert.rejects(
      connectAndProvision({
        uri: TEST_URI,
        confirmedTarget: TARGET,
        input: validInput,
        dependencies: { mongoose: fake, UserModel: model },
      }),
    );
    assert.equal(model.calls.create.length, 0);
    assert.equal(fake.calls.disconnect, 1);
  }
});

test("database safety options and suitable email index are required", async () => {
  const fake = createFakeMongoose();
  const model = createUserModel();
  const result = await connectAndProvision({
    uri: TEST_URI,
    confirmedTarget: TARGET,
    input: validInput,
    dependencies: { mongoose: fake, UserModel: model },
  });
  assert.deepEqual(fake.calls.connect[0].options, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 10000,
    directConnection: true,
    autoIndex: false,
    autoCreate: false,
  });
  assert.equal(result.lifecycle.accountCreation, "confirmed_success");
  assert.equal(fake.calls.disconnect, 1);
});

test("missing or unsuitable email indexes abort before creation", async () => {
  const unsuitableIndexes = [
    [],
    [{ key: { _id: 1 }, unique: true }],
    [{ key: { email: 1 }, unique: true, sparse: true }],
    [{ key: { email: 1 }, unique: true, partialFilterExpression: { role: "admin" } }],
    [{ key: { email: 1, role: 1 }, unique: true }],
  ];
  for (const indexes of unsuitableIndexes) {
    const fake = createFakeMongoose({ indexes });
    const model = createUserModel();
    await assert.rejects(
      connectAndProvision({
        uri: TEST_URI,
        confirmedTarget: TARGET,
        input: validInput,
        dependencies: { mongoose: fake, UserModel: model },
      }),
      (error) => error.category === "EMAIL_INDEX",
    );
    assert.equal(model.calls.create.length, 0);
    assert.equal(fake.calls.disconnect, 1);
  }
});

test("legacy unnormalized stored emails prevent provisioning", async () => {
  const fake = createFakeMongoose({ storedEmails: [" Admin@Example.com "] });
  const model = createUserModel();
  await assert.rejects(
    connectAndProvision({
      uri: TEST_URI,
      confirmedTarget: TARGET,
      input: validInput,
      dependencies: { mongoose: fake, UserModel: model },
    }),
    (error) => error.category === "EMAIL_NORMALIZATION",
  );
  assert.equal(model.calls.create.length, 0);
  assert.equal(fake.calls.disconnect, 1);
});

test("cancellation during connection and index verification prevents writes and disconnects", async () => {
  for (const stage of ["connect", "indexes", "stored_emails"]) {
    const controller = new AbortController();
    const fake = createFakeMongoose({
      onConnect: stage === "connect" ? () => controller.abort() : undefined,
      onListIndexes: stage === "indexes" ? () => controller.abort() : undefined,
      onFindEmails: stage === "stored_emails" ? () => controller.abort() : undefined,
    });
    const model = createUserModel();
    await assert.rejects(
      connectAndProvision({
        uri: TEST_URI,
        confirmedTarget: TARGET,
        input: validInput,
        signal: controller.signal,
        dependencies: { mongoose: fake, UserModel: model },
      }),
      (error) => error.category === "CANCELLED",
    );
    assert.equal(model.calls.create.length, 0);
    assert.equal(fake.calls.disconnect, 1);
  }
});

test("cancellation during lookup, hashing, or immediately before create prevents writes", async () => {
  const phases = ["lookup", "hash", "before_create"];
  for (const phase of phases) {
    const controller = new AbortController();
    const model = createUserModel(null, async (document) => ({ _id: "unused", ...document }));
    const dependencies = {
      UserModel: {
        ...model,
        findOne(query) {
          const queryObject = model.findOne(query);
          return {
            lean: async () => {
              if (phase === "lookup") controller.abort();
              return queryObject.lean();
            },
          };
        },
      },
      bcrypt: {
        hash: async () => {
          if (phase === "hash") controller.abort();
          return "safe-fake-hash";
        },
      },
      signal: controller.signal,
      checkpoint: async (current) => {
        if (phase === "before_create" && current === "before_account_creation") {
          controller.abort();
        }
      },
    };
    await assert.rejects(
      provisionAdministrator(validInput, dependencies),
      (error) => error.category === "CANCELLED",
    );
    assert.equal(model.calls.create.length, 0);
  }
});

test("cancellation during account creation reports uncertainty and never retries", async () => {
  const controller = new AbortController();
  const model = createUserModel(null, async () => {
    controller.abort();
    throw new Error("network outcome unknown");
  });
  const lifecycle = { accountCreation: "not_started" };
  await assert.rejects(
    provisionAdministrator(validInput, {
      UserModel: model,
      lifecycle,
      signal: controller.signal,
    }),
    (error) => error.category === "OUTCOME_UNCERTAIN" && error.message === UNCERTAIN_CREATION_MESSAGE,
  );
  assert.equal(lifecycle.accountCreation, "outcome_uncertain");
  assert.equal(model.calls.create.length, 1);
});

test("CLI reports uncertain create outcome without exposing error details", async () => {
  const dependencies = createRunDependencies({
    connectAndProvision: async () => {
      throw new ProvisioningError("OUTCOME_UNCERTAIN", UNCERTAIN_CREATION_MESSAGE);
    },
  });
  assert.equal(await run(dependencies), 1);
  assert.equal(dependencies.errors.text.includes(UNCERTAIN_CREATION_MESSAGE), true);
  assert.equal(dependencies.errors.text.includes("private-password"), false);
});

test("cleanup failure does not alter confirmed account creation outcome", async () => {
  const fake = createFakeMongoose({
    onDisconnect: async () => {
      throw new Error("private cleanup detail");
    },
  });
  const result = await connectAndProvision({
    uri: TEST_URI,
    confirmedTarget: TARGET,
    input: validInput,
    dependencies: { mongoose: fake, UserModel: createUserModel() },
  });
  assert.equal(result.lifecycle.accountCreation, "confirmed_success");
  assert.equal(result.cleanupSucceeded, false);
});

test("cancellation during database cleanup still awaits disconnection", async () => {
  const controller = new AbortController();
  let disconnectFinished = false;
  const fake = createFakeMongoose({
    onDisconnect: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      disconnectFinished = true;
    },
  });
  const result = await connectAndProvision({
    uri: TEST_URI,
    confirmedTarget: TARGET,
    input: validInput,
    signal: controller.signal,
    dependencies: { mongoose: fake, UserModel: createUserModel() },
  });
  assert.equal(result.lifecycle.accountCreation, "confirmed_success");
  assert.equal(disconnectFinished, true);
  assert.equal(fake.calls.disconnect, 1);
});

test("connection errors are sanitized and disconnection is attempted", async () => {
  const fake = createFakeMongoose({
    onConnect: async () => {
      throw new Error("mongodb://private-user:private-password@host/private-database");
    },
  });
  await assert.rejects(
    connectAndProvision({
      uri: TEST_URI,
      confirmedTarget: TARGET,
      input: validInput,
      dependencies: { mongoose: fake, UserModel: createUserModel() },
    }),
    (error) => error.category === "DATABASE_FAILURE" && !error.message.includes("private"),
  );
  assert.equal(fake.calls.disconnect, 1);
});
