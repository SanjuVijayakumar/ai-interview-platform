import { randomBytes } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import {
  ProvisioningError,
  UNCERTAIN_CREATION_MESSAGE,
  provisionAdministrator,
  validateAdministratorInput,
} from "../services/adminProvisioningService.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const ENV_PATH = path.join(SERVER_DIRECTORY, ".env");
const TERMINAL_QUIET_PERIOD_MS = 250;
const CONNECTION_TIMEOUT_MS = 10000;

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new ProvisioningError("CANCELLED", "Operation cancelled.");
  }
}

function targetString(target) {
  return `${target.host}/${target.databaseName}`;
}

export function getDatabaseTarget(uri) {
  if (typeof uri !== "string" || !uri.trim() || uri.includes("?") || uri.includes("#")) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "mongodb:" || !parsed.hostname || parsed.hostname.includes(",")) {
    return null;
  }
  if (parsed.search || parsed.hash) return null;

  const rawName = parsed.pathname.replace(/^\/+/, "");
  if (!rawName || rawName.includes("/") || rawName.includes("\\") || parsed.pathname.includes("//")) {
    return null;
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (!databaseName || !/^[A-Za-z0-9_.-]+$/.test(databaseName)) return null;

  const hostName = parsed.hostname.toLowerCase();
  const port = parsed.port || "27017";
  return {
    databaseName,
    host: `${hostName}:${port}`,
    protocol: "mongodb:",
    topology: "single-host-standalone",
  };
}

export function getSanitizedDatabaseTarget(uri) {
  const target = getDatabaseTarget(uri);
  return target ? targetString(target) : null;
}

export function generateConfirmationChallenge() {
  return randomBytes(24).toString("hex");
}

export function verifyConnectedServer(target, topologyDescription) {
  const servers = topologyDescription?.servers;
  if (!(servers instanceof Map) || servers.size !== 1) return false;
  const [address, serverDescription] = servers.entries().next().value;
  return (
    String(address).toLowerCase() === target.host.toLowerCase() &&
    serverDescription?.type === "Standalone"
  );
}

export function verifyUserEmailIndex(collectionIndexes) {
  return collectionIndexes.some((index) => {
    if (!index || index.unique !== true) return false;
    if (index.partialFilterExpression || index.sparse === true) return false;
    if (index.collation && index.collation.locale !== "simple") return false;
    const key = index.key;
    return key && key.email === 1 && Object.keys(key).length === 1;
  });
}

export async function verifyStoredEmailsNormalized(collection, signal) {
  const cursor = collection.find({}, { projection: { email: 1 } });
  let allNormalized = true;
  try {
    for await (const document of cursor) {
      throwIfCancelled(signal);
      if (
        typeof document.email !== "string" ||
        document.email !== document.email.trim().toLowerCase()
      ) {
        allNormalized = false;
        break;
      }
    }
  } finally {
    if (typeof cursor.close === "function") {
      await Promise.resolve(cursor.close()).catch(() => {});
    }
  }
  throwIfCancelled(signal);
  return allNormalized;
}

async function readTerminalInput({
  question,
  hidden,
  input,
  output,
  signal,
  cancel,
  quietPeriodMs = TERMINAL_QUIET_PERIOD_MS,
  timers = { setTimeout, clearTimeout },
}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new ProvisioningError("TERMINAL", "Interactive terminal input is unavailable.");
  }
  throwIfCancelled(signal);

  return new Promise((resolve, reject) => {
    let originalRawMode = Boolean(input.isRaw);
    let settled = false;
    let lineComplete = false;
    let spillover = false;
    let ignoreLineFeed = false;
    let characters = [];
    let settleTimer;
    const decoder = new StringDecoder("utf8");

    const cleanup = () => {
      if (settleTimer) timers.clearTimeout(settleTimer);
      input.removeListener("data", onData);
      input.removeListener("error", onInputError);
      input.removeListener("end", onInputEnd);
      signal?.removeEventListener("abort", onAbortBound);

      let restoreFailed = false;
      try {
        input.pause();
      } catch {
        restoreFailed = true;
      }
      try {
        input.setRawMode(originalRawMode);
      } catch {
        restoreFailed = true;
      }
      return restoreFailed;
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      const restoreFailed = cleanup();
      try {
        if (!lineComplete) output.write("\n");
      } catch {
        if (!error) error = new ProvisioningError("TERMINAL", "Terminal output failed.");
      }
      if (!error && restoreFailed) {
        error = new ProvisioningError("TERMINAL", "Terminal mode could not be restored.");
      }
      if (error) reject(error);
      else resolve(value);
    };

    const settleLine = () => {
      if (settleTimer) timers.clearTimeout(settleTimer);
      settleTimer = timers.setTimeout(() => {
        if (spillover) {
          finish(new ProvisioningError("MULTILINE_INPUT", "Multi-line pasted input is not accepted."));
        } else {
          finish(null, characters.join(""));
        }
      }, quietPeriodMs);
    };

    const onAbort = () => finish(new ProvisioningError("CANCELLED", "Operation cancelled."));
    const onInputError = () =>
      finish(new ProvisioningError("TERMINAL", "Terminal input failed."));
    const onInputEnd = () =>
      finish(new ProvisioningError("TERMINAL", "Terminal input ended unexpectedly."));

    const onData = (chunk) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of Array.from(text)) {
        const code = character.codePointAt(0);

        if (lineComplete) {
          if (ignoreLineFeed && code === 10) {
            ignoreLineFeed = false;
            continue;
          }
          ignoreLineFeed = false;
          spillover = true;
          settleLine();
          continue;
        }

        if (code === 3) {
          cancel();
          return;
        }
        if (code === 13 || code === 10) {
          if (code === 13) ignoreLineFeed = true;
          lineComplete = true;
          try {
            output.write("\n");
          } catch {
            finish(new ProvisioningError("TERMINAL", "Terminal output failed."));
            return;
          }
          settleLine();
          continue;
        }
        if (code === 8 || code === 127) {
          if (characters.length) {
            characters.pop();
            if (!hidden) output.write("\b \b");
          }
          continue;
        }
        if (code < 32 || (code >= 127 && code <= 159)) continue;
        characters.push(character);
        if (!hidden) {
          try {
            output.write(character);
          } catch {
            finish(new ProvisioningError("TERMINAL", "Terminal output failed."));
            return;
          }
        }
      }
    };

    const onAbortBound = () => onAbort();
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.on("error", onInputError);
      input.on("end", onInputEnd);
      signal?.addEventListener("abort", onAbortBound, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      output.write(question);
      input.resume();
    } catch {
      finish(new ProvisioningError("TERMINAL", "Interactive terminal input is unavailable."));
    }
  });
}

export function readVisibleInput(
  question,
  input = process.stdin,
  output = process.stdout,
  signal,
  cancel = () => {},
  options = {},
) {
  return readTerminalInput({ ...options, question, hidden: false, input, output, signal, cancel });
}

export function readHiddenInput(
  question,
  input = process.stdin,
  output = process.stdout,
  signal,
  cancel = () => {},
  options = {},
) {
  return readTerminalInput({ ...options, question, hidden: true, input, output, signal, cancel });
}

export async function connectAndProvision({
  uri,
  confirmedTarget,
  input,
  signal,
  lifecycle = { accountCreation: "not_started" },
  dependencies = {},
}) {
  const mongooseInstance = dependencies.mongoose || mongoose;
  const target = getDatabaseTarget(uri);
  let result;
  let failure;
  let cleanupSucceeded = true;

  try {
    throwIfCancelled(signal);
    if (!target || targetString(target) !== confirmedTarget) {
      throw new ProvisioningError("DATABASE_TARGET", "The confirmed database target is invalid.");
    }

    await mongooseInstance.connect(uri, {
      serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECTION_TIMEOUT_MS,
      socketTimeoutMS: CONNECTION_TIMEOUT_MS,
      directConnection: true,
      autoIndex: false,
      autoCreate: false,
    });
    throwIfCancelled(signal);

    const actualName = mongooseInstance.connection.db?.databaseName;
    if (!actualName || actualName !== target.databaseName) {
      throw new ProvisioningError("DATABASE_TARGET", "The connected database does not match the confirmed target.");
    }

    const client = mongooseInstance.connection.getClient();
    if (!verifyConnectedServer(target, client?.topology?.description)) {
      throw new ProvisioningError("DATABASE_SERVER", "The connected MongoDB server could not be verified.");
    }

    const usersCollection = mongooseInstance.connection.db.collection("users");
    const indexes = await usersCollection.listIndexes().toArray();
    throwIfCancelled(signal);
    if (!verifyUserEmailIndex(indexes)) {
      throw new ProvisioningError("EMAIL_INDEX", "A usable unique email index could not be verified.");
    }
    if (!(await verifyStoredEmailsNormalized(usersCollection, signal))) {
      throw new ProvisioningError(
        "EMAIL_NORMALIZATION",
        "Stored email values are not consistently normalized.",
      );
    }

    result = await provisionAdministrator(input, {
      ...dependencies,
      lifecycle,
      signal,
    });
  } catch (error) {
    if (error instanceof ProvisioningError) {
      failure = error;
    } else if (signal?.aborted && lifecycle.accountCreation !== "in_progress") {
      failure = new ProvisioningError("CANCELLED", "Operation cancelled.");
    } else if (lifecycle.accountCreation === "in_progress") {
      lifecycle.accountCreation = "outcome_uncertain";
      failure = new ProvisioningError("OUTCOME_UNCERTAIN", UNCERTAIN_CREATION_MESSAGE);
    } else {
      failure = new ProvisioningError("DATABASE_FAILURE", "Database provisioning checks failed.");
    }
  } finally {
    try {
      await mongooseInstance.disconnect();
    } catch {
      cleanupSucceeded = false;
    }
  }

  if (failure) throw failure;
  return { ...result, lifecycle, cleanupSucceeded };
}

function sanitizeDisplayValue(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export async function run(dependencies = {}) {
  const runtimeProcess = dependencies.process || process;
  const inputStream = dependencies.stdin || process.stdin;
  const outputStream = dependencies.stdout || process.stdout;
  const errorStream = dependencies.stderr || process.stderr;
  const args = dependencies.argv || runtimeProcess.argv;
  const environment = dependencies.environment || process.env;
  const writeOut = (message) => outputStream.write(`${message}\n`);
  const writeError = (message) => errorStream.write(`${message}\n`);
  const controller = new AbortController();
  const signal = controller.signal;
  const onSigint = () => controller.abort();
  let name;
  let email;
  let password;
  let passwordConfirmation;
  const lifecycle = { accountCreation: "not_started" };
  const visibleReader =
    dependencies.readVisibleInput ||
    ((question) => readVisibleInput(question, inputStream, outputStream, signal, onSigint));
  const hiddenReader =
    dependencies.readHiddenInput ||
    ((question) => readHiddenInput(question, inputStream, outputStream, signal, onSigint));

  runtimeProcess.on("SIGINT", onSigint);
  try {
    if (args.length !== 2) {
      writeError("Unexpected command-line arguments are not allowed.");
      return 1;
    }
    if (!inputStream.isTTY || !outputStream.isTTY) {
      writeError("This command requires an interactive terminal.");
      return 1;
    }

    if (dependencies.loadEnvironment) dependencies.loadEnvironment();
    else dotenv.config({ path: ENV_PATH, quiet: true });

    const uri = environment.MONGO_URI;
    if (typeof uri !== "string" || !uri.trim()) {
      writeError("MONGO_URI is not explicitly configured.");
      return 1;
    }

    const target = getDatabaseTarget(uri);
    if (!target) {
      writeError("The database target is unsupported or ambiguous.");
      return 1;
    }

    name = await visibleReader("Administrator name: ");
    throwIfCancelled(signal);
    email = await visibleReader("Administrator email: ");
    throwIfCancelled(signal);
    password = await hiddenReader("Password: ");
    throwIfCancelled(signal);
    passwordConfirmation = await hiddenReader("Confirm password: ");
    throwIfCancelled(signal);

    const validated = validateAdministratorInput({
      name,
      email,
      password,
      passwordConfirmation,
    });

    const confirmedTarget = targetString(target);
    const challenge = (dependencies.generateChallenge || generateConfirmationChallenge)();
    const confirmationPhrase = `CREATE ADMIN IN ${confirmedTarget} CONFIRM ${challenge}`;
    writeOut(`Database target: ${confirmedTarget}`);
    writeOut("Ensure no concurrent out-of-band user writes bypass application email normalization.");
    writeOut("Final authorization is required. Input will be hidden.");
    writeOut(`Confirmation challenge: ${challenge}`);
    writeOut(`Type exactly: ${confirmationPhrase}`);
    const confirmation = await hiddenReader("Final authorization (input hidden): ");
    throwIfCancelled(signal);
    if (confirmation !== confirmationPhrase) {
      writeError("Confirmation did not match. No database connection was made.");
      return 1;
    }

    const provision = dependencies.connectAndProvision || connectAndProvision;
    const account = await provision({
      uri,
      confirmedTarget,
      input: { name, email, password, passwordConfirmation },
      signal,
      lifecycle,
      dependencies: dependencies.provisioningDependencies,
    });

    writeOut("Administrator created successfully.");
    writeOut(`User ID: ${sanitizeDisplayValue(account.id)}`);
    writeOut(`Role: ${account.role}`);
    writeOut(`Database target: ${confirmedTarget}`);
    if (!account.cleanupSucceeded) {
      writeError("Administrator creation is confirmed, but database disconnection reported a failure.");
    }
    return 0;
  } catch (error) {
    if (error instanceof ProvisioningError && error.category === "OUTCOME_UNCERTAIN") {
      writeError(UNCERTAIN_CREATION_MESSAGE);
      return signal.aborted ? 130 : 1;
    }
    if (lifecycle.accountCreation === "outcome_uncertain") {
      writeError(UNCERTAIN_CREATION_MESSAGE);
      return signal.aborted ? 130 : 1;
    }
    if (signal.aborted || (error instanceof ProvisioningError && error.category === "CANCELLED")) {
      writeError("Operation cancelled.");
      return 130;
    }
    writeError(error instanceof ProvisioningError ? error.message : "Administrator provisioning failed.");
    return 1;
  } finally {
    name = undefined;
    email = undefined;
    password = undefined;
    passwordConfirmation = undefined;
    if (typeof inputStream.pause === "function") {
      try {
        inputStream.pause();
      } catch {
        writeError("Terminal input stream cleanup failed.");
      }
    }
    runtimeProcess.removeListener("SIGINT", onSigint);
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  run().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    console.error("Administrator provisioning failed.");
    process.exitCode = 1;
  });
}
