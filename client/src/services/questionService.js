import { getAuthToken } from "./authService.js";

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

export async function getQuestions(interviewId) {
  const data = await request(`/${encodeURIComponent(interviewId)}`);
  if (!Array.isArray(data.questions)) throw new Error("The questions response was not in the expected format.");
  return data.questions;
}

export async function createQuestion(questionData) {
  const data = await request("", { method: "POST", body: JSON.stringify(questionData) });
  return data.question;
}

export async function updateQuestion(questionId, questionData) {
  const data = await request(`/${encodeURIComponent(questionId)}`, {
    method: "PATCH",
    body: JSON.stringify(questionData),
  });
  return data.question;
}

export async function deleteQuestion(questionId) {
  return request(`/${encodeURIComponent(questionId)}`, { method: "DELETE" });
}

export async function generateInterviewQuestions(interviewId, preferences) {
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
