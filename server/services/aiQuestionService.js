import { randomUUID } from "node:crypto";
import { AIProviderConfigurationError, getAIProvider } from "../config/aiProvider.js";
import { getLegacyOpenAIService } from "./legacyOpenAIService.js";
import { logQuestionGenerationOutcome } from "./aiProviders/normalizeProviderError.js";

class AIQuestionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AIQuestionConfigurationError";
    this.code = "configuration";
  }
}

const DIFFICULTIES = new Set(["Beginner", "Intermediate", "Advanced"]);
const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionText: { type: "string" },
          category: { type: "string" },
          difficulty: { type: "string", enum: [...DIFFICULTIES] },
          expectedAnswer: { type: "string" },
        },
        required: ["questionText", "category", "difficulty", "expectedAnswer"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

export class AIQuestionResponseError extends Error {
  constructor(message = "The AI returned an invalid question set.", code = "invalid_output") {
    super(message);
    this.name = "AIQuestionResponseError";
    this.code = code;
  }
}

class AIQuestionCancelledError extends Error {
  constructor() {
    super("The AI question request was cancelled.");
    this.name = "AIQuestionCancelledError";
    this.code = "caller_cancelled";
  }
}

function mapProviderError(error) {
  if (error instanceof AIQuestionConfigurationError || error instanceof AIQuestionResponseError ||
      ["AIQuestionRateLimitError", "AIQuestionTimeoutError", "AIQuestionProviderError", "AIQuestionCancelledError"].includes(error?.name)) {
    return error;
  }
  if (error instanceof AIProviderConfigurationError || error?.code === "configuration") {
    return new AIQuestionConfigurationError("AI provider configuration is unavailable or invalid.");
  }
  if (error?.code === "rate_limited") {
    const rateError = new Error("The AI question service is rate limited. Please try again shortly.");
    rateError.name = "AIQuestionRateLimitError";
    rateError.code = "rate_limited";
    return rateError;
  }
  if (error?.code === "timeout") {
    const timeoutError = new Error("The AI question request timed out.");
    timeoutError.name = "AIQuestionTimeoutError";
    timeoutError.code = "timeout";
    return timeoutError;
  }
  if (error?.code === "caller_cancelled") return new AIQuestionCancelledError();
  if (["refused", "incomplete_output", "invalid_output"].includes(error?.code)) {
    const message = error.code === "refused"
      ? "The AI could not generate questions for this request."
      : error.code === "incomplete_output"
        ? "The AI could not complete the requested question set. Please try again."
        : "The AI returned an invalid question set.";
    return new AIQuestionResponseError(message, error.code);
  }
  const providerError = new Error("The AI question service is temporarily unavailable.");
  providerError.name = "AIQuestionProviderError";
  providerError.code = "provider_unavailable";
  if (error?.code === "quota_exhausted") providerError.code = "quota_exhausted";
  return providerError;
}

const validateQuestions = (value, count) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Array.isArray(value.questions) ||
      value.questions.length !== count) {
    throw new AIQuestionResponseError();
  }

  const seen = new Set();
  for (const item of value.questions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AIQuestionResponseError();
    }
    const keys = Object.keys(item).sort();
    if (keys.join(",") !== ["category", "difficulty", "expectedAnswer", "questionText"].join(",") ||
        typeof item.questionText !== "string" || !item.questionText.trim() ||
        typeof item.category !== "string" || !item.category.trim() ||
        !DIFFICULTIES.has(item.difficulty) ||
        typeof item.expectedAnswer !== "string" || item.expectedAnswer.trim().length < 20) {
      throw new AIQuestionResponseError();
    }
    const normalized = item.questionText.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) throw new AIQuestionResponseError();
    seen.add(normalized);
  }

  return value.questions.map(({ questionText, category, difficulty, expectedAnswer }) => ({
    questionText: questionText.trim(),
    category: category.trim(),
    difficulty,
    expectedAnswer: expectedAnswer.trim(),
  }));
};

export const generateInterviewQuestions = async (
  { candidate, interview, preferences },
  { providerFactory = getAIProvider, signal, correlationId: inputCorrelationId } = {}
) => {
  const correlationId = inputCorrelationId || randomUUID();
  const { count, difficulty, category } = preferences;
  const prompt = `Create exactly ${count} distinct, realistic interview questions for the candidate and interview below.\n\n` +
    `Candidate profile (from the platform):\n- Skills: ${candidate.skills.length ? candidate.skills.join(", ") : "Not provided"}\n` +
    `- Experience: ${candidate.experience} years\n- Target role: ${candidate.targetRole || "Not provided"}\n\n` +
    `Interview:\n- Title: ${interview.title}\n- Category: ${interview.category}\n- Saved difficulty: ${interview.difficulty}\n\n` +
    `Generation preferences:\n- Difficulty: ${difficulty}\n- Question category: ${category}\n\n` +
    `Tailor complexity to the candidate's experience and target role. Avoid repetition and generic trivia. ` +
    `Each expectedAnswer must explain the key concepts of a strong answer with useful detail, not merely say what to include. ` +
    `Return only the required structured data.`;

  let outcome = "failure";
  let errorCategory;
  let httpStatus;
  try {
    let provider;
    let response;
    try {
      provider = await providerFactory();
      response = await provider.generate({
        systemInstruction: "You generate high-quality interview practice questions.",
        userPrompt: prompt,
        responseSchema: QUESTION_SCHEMA,
        maxOutputTokens: Math.min(12000, 1200 + count * 900),
        timeoutMs: provider.timeoutMs,
        signal,
        retry503: provider.provider === "gemini",
        correlationId,
      });
    } catch (error) {
      httpStatus = error?.diagnostics?.httpStatus ?? error?.httpStatus ?? error?.status;
      const mapped = mapProviderError(error);
      if (httpStatus && !mapped.httpStatus) mapped.httpStatus = httpStatus;
      throw mapped;
    }

    if (response?.incomplete) {
      throw new AIQuestionResponseError("The AI could not complete the requested question set. Please try again.", "incomplete_output");
    }
    if (response?.refused) {
      throw new AIQuestionResponseError("The AI could not generate questions for this request.", "refused");
    }
    if (typeof response?.text !== "string" || !response.text.trim()) {
      throw new AIQuestionResponseError();
    }

    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new AIQuestionResponseError();
    }
    const questions = validateQuestions(parsed, count);
    outcome = "success";
    return questions;
  } catch (error) {
    if (!httpStatus) {
      httpStatus = error?.httpStatus ?? error?.diagnostics?.httpStatus ?? error?.status;
    }
    errorCategory = ["configuration", "rate_limited", "quota_exhausted", "provider_unavailable", "timeout", "refused", "incomplete_output", "invalid_output", "caller_cancelled"].includes(error?.code)
      ? error.code
      : "provider_unavailable";
    if (errorCategory === "caller_cancelled" || signal?.aborted) outcome = "cancelled";
    throw error;
  } finally {
    logQuestionGenerationOutcome({ correlationId, outcome, errorCategory, httpStatus });
  }
};

export { AIQuestionConfigurationError };
// Backward-compatible entry points used by answer evaluation until it is migrated.
export const getAIQuestionService = getLegacyOpenAIService;
export const getOpenAIService = getLegacyOpenAIService;
