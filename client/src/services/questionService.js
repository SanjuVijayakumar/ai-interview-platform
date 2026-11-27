import { getAuthToken } from "./authService.js";
import { AuthenticatedRequestError, authenticatedRequest } from "./authenticatedRequest.js";

const API_URL = "http://localhost:5000/api/questions";
const INTERVIEW_API_URL = "http://localhost:5000/api/interviews";

async function request(path = "", options = {}, baseUrl = API_URL) {
  const token = getAuthToken();
  if (!token) throw new Error("Your session is missing. Please sign in again.");

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Could not connect to PrepX. Check that the backend is running and try again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "The question request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function safePathSegment(id) {
  if (typeof id !== "string" || !id || /[^A-Za-z0-9_-]/.test(id)) {
    throw new AuthenticatedRequestError("invalid-destination");
  }
  return id;
}

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPersistedQuestion(question) {
  return isNonblankString(question?._id) &&
    isNonblankString(question.interview) &&
    isNonblankString(question.questionText) &&
    isNonblankString(question.category) &&
    isNonblankString(question.difficulty) &&
    Number.isFinite(question.order) &&
    (question.expectedAnswer == null || typeof question.expectedAnswer === "string");
}

const difficulties = new Set(["Beginner", "Intermediate", "Advanced"]);

function isGeneratedQuestion(question) {
  return isNonblankString(question?.questionText) &&
    isNonblankString(question.category) &&
    difficulties.has(question.difficulty) &&
    isNonblankString(question.expectedAnswer);
}

async function requestWithCapability(url, { capability, signal }, requestOptions) {
  const { data, status } = await authenticatedRequest(capability, url, {
    ...requestOptions,
    signal,
    ...(requestOptions.body ? { headers: { "Content-Type": "application/json" } } : {}),
  });
  if (data?.success !== true) throw new AuthenticatedRequestError("malformed-response", status);
  return { data, status };
}

async function saveQuestionWithCapability(url, options, method, questionData) {
  const { data, status } = await requestWithCapability(url, options, {
    method,
    body: JSON.stringify(questionData),
  });
  if (!isPersistedQuestion(data.question)) throw new AuthenticatedRequestError("malformed-response", status);
  return data.question;
}

export async function getQuestions(interviewId, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await requestWithCapability(`${API_URL}/${safePathSegment(interviewId)}`, options, {
      method: "GET",
    });
    if (!Array.isArray(data.questions) || !data.questions.every(isPersistedQuestion)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data.questions;
  }

  const data = await request(`/${encodeURIComponent(interviewId)}`);
  if (!Array.isArray(data.questions)) throw new Error("The questions response was not in the expected format.");
  return data.questions;
}

export async function createQuestion(questionData, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    return saveQuestionWithCapability(API_URL, options, "POST", questionData);
  }
  const data = await request("", { method: "POST", body: JSON.stringify(questionData) });
  return data.question;
}

export async function updateQuestion(questionId, questionData, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    return saveQuestionWithCapability(`${API_URL}/${safePathSegment(questionId)}`, options, "PATCH", questionData);
  }
  const data = await request(`/${encodeURIComponent(questionId)}`, {
    method: "PATCH",
    body: JSON.stringify(questionData),
  });
  return data.question;
}

export async function deleteQuestion(questionId, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const { data, status } = await requestWithCapability(`${API_URL}/${safePathSegment(questionId)}`, options, {
      method: "DELETE",
    });
    if (!isNonblankString(data.questionId)) throw new AuthenticatedRequestError("malformed-response", status);
    return data;
  }
  return request(`/${encodeURIComponent(questionId)}`, { method: "DELETE" });
}

export async function generateInterviewQuestions(interviewId, preferences, options = {}) {
  if (Object.hasOwn(options ?? {}, "capability")) {
    const url = `${INTERVIEW_API_URL}/${safePathSegment(interviewId)}/generate-questions`;
    const count = preferences?.count;
    const { data, status } = await requestWithCapability(url, options, {
      method: "POST",
      body: JSON.stringify(preferences),
    });
    if (!Array.isArray(data.questions) || data.questions.length === 0 ||
        data.questions.length !== count || !data.questions.every(isGeneratedQuestion)) {
      throw new AuthenticatedRequestError("malformed-response", status);
    }
    return data.questions;
  }

  const data = await request(
    `/${encodeURIComponent(interviewId)}/generate-questions`,
    { method: "POST", body: JSON.stringify(preferences) },
    INTERVIEW_API_URL
  );
  if (!Array.isArray(data.questions)) {
    throw new Error("The generated questions response was not in the expected format.");
  }
  return data.questions;
}
