import bcrypt from "bcrypt";
import User from "../models/User.js";

export const UNCERTAIN_CREATION_MESSAGE =
  "Administrator creation could not be confirmed. The account may have been created. Verify the account in the intended database before attempting provisioning again.";

export class ProvisioningError extends Error {
  constructor(category, message) {
    super(message);
    this.name = "ProvisioningError";
    this.category = category;
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new ProvisioningError("CANCELLED", "Operation cancelled.");
  }
}

async function checkpoint(dependencies, phase) {
  if (dependencies.checkpoint) await dependencies.checkpoint(phase);
}

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function validateAdministratorInput(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const passwordConfirmation =
    typeof input.passwordConfirmation === "string" ? input.passwordConfirmation : "";

  if (!name) throw new ProvisioningError("VALIDATION", "Administrator name is required.");
  if (!email) throw new ProvisioningError("VALIDATION", "Administrator email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ProvisioningError("VALIDATION", "Administrator email is invalid.");
  }
  if (!password) throw new ProvisioningError("VALIDATION", "Password is required.");
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new ProvisioningError("VALIDATION", "Password exceeds 72 UTF-8 bytes.");
  }
  if (Array.from(password).length < 12) {
    throw new ProvisioningError("VALIDATION", "Password must be at least 12 characters.");
  }
  if (password !== passwordConfirmation) {
    throw new ProvisioningError("VALIDATION", "Password confirmation does not match.");
  }

  return { name, email, password };
}

export async function provisionAdministrator(input = {}, dependencies = {}) {
  const validated = validateAdministratorInput(input);
  const UserModel = dependencies.UserModel || User;
  const bcryptImplementation = dependencies.bcrypt || bcrypt;
  const lifecycle = dependencies.lifecycle || { accountCreation: "not_started" };
  const signal = dependencies.signal;
  const cost = 12;

  throwIfCancelled(signal);
  await checkpoint(dependencies, "before_duplicate_lookup");
  throwIfCancelled(signal);

  let existing;
  try {
    existing = await UserModel.findOne({ email: validated.email }).lean();
  } catch {
    if (signal?.aborted) throw new ProvisioningError("CANCELLED", "Operation cancelled.");
    throw new ProvisioningError("PROVISIONING_FAILURE", "Administrator provisioning failed.");
  }
  throwIfCancelled(signal);
  if (existing) {
    throw new ProvisioningError("DUPLICATE_ACCOUNT", "An account with this email already exists.");
  }

  await checkpoint(dependencies, "after_duplicate_lookup");
  throwIfCancelled(signal);

  let passwordHash;
  try {
    passwordHash = await bcryptImplementation.hash(validated.password, cost);
  } catch {
    if (signal?.aborted) throw new ProvisioningError("CANCELLED", "Operation cancelled.");
    throw new ProvisioningError("PROVISIONING_FAILURE", "Administrator provisioning failed.");
  }
  throwIfCancelled(signal);

  await checkpoint(dependencies, "before_account_creation");
  throwIfCancelled(signal);

  lifecycle.accountCreation = "in_progress";
  let created;
  try {
    created = await UserModel.create({
      name: validated.name,
      email: validated.email,
      password: passwordHash,
      role: "admin",
    });
    lifecycle.accountCreation = "confirmed_success";
  } catch (error) {
    if (error && error.code === 11000) {
      lifecycle.accountCreation = "definitively_rejected";
      throw new ProvisioningError("DUPLICATE_ACCOUNT", "An account with this email already exists.");
    }

    lifecycle.accountCreation = "outcome_uncertain";
    throw new ProvisioningError("OUTCOME_UNCERTAIN", UNCERTAIN_CREATION_MESSAGE);
  }

  return {
    id: String(created._id),
    name: created.name,
    email: created.email,
    role: created.role,
    lifecycle,
  };
}
