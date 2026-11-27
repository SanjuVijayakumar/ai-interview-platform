import { authenticatedRequest, AuthenticatedRequestError } from "./authenticatedRequest.js";

const profileUrl = "http://localhost:5000/api/auth/profile";

function isNonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSkillsList(value) {
  return Array.isArray(value) && Array.from(value).every(isNonBlank);
}

function isExperience(value) {
  return Number.isFinite(value) && value >= 0;
}

async function requestProfile(capability, options) {
  const { status, data } = await authenticatedRequest(capability, profileUrl, options);
  const user = data?.user;
  if (
    data?.success !== true ||
    typeof user?.id !== "string" || !/^[a-f\d]{24}$/i.test(user.id) ||
    !isNonBlank(user.name) || !isNonBlank(user.email) ||
    !["user", "admin"].includes(user.role) || !isSkillsList(user.skills) ||
    !isExperience(user.experience) || typeof user.targetRole !== "string"
  ) {
    throw new AuthenticatedRequestError("malformed-response", status);
  }
  const { id, name, email, role, skills, experience, targetRole } = user;
  return { id, name, email, role, skills, experience, targetRole };
}

export function getProfile({ capability, signal } = {}) {
  return requestProfile(capability, { method: "GET", signal });
}

export async function updateProfile(updates, { capability, signal } = {}) {
  const payload = {};
  for (const [field, validate] of [
    ["name", isNonBlank],
    ["skills", isSkillsList],
    ["experience", isExperience],
    ["targetRole", isNonBlank],
  ]) {
    if (!updates || !Object.hasOwn(updates, field)) continue;
    if (!validate(updates[field])) {
      throw new AuthenticatedRequestError("invalid-request-options");
    }
    payload[field] = updates[field];
  }
  if (Object.keys(payload).length === 0) {
    throw new AuthenticatedRequestError("invalid-request-options");
  }
  return requestProfile(capability, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}
