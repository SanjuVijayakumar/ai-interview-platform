import OpenAI from "openai";

let openAIClient;

class AIQuestionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AIQuestionConfigurationError";
  }
}

const readConfiguration = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  if (!apiKey) {
    throw new AIQuestionConfigurationError(
      "OpenAI API configuration is unavailable."
    );
  }

  if (!model || /\s/.test(model)) {
    throw new AIQuestionConfigurationError(
      "OpenAI model configuration is invalid."
    );
  }

  return { apiKey, model };
};

/**
 * Returns the configured model and a cached OpenAI client without making an API call.
 * Configuration is read on demand so dotenv can load before this service is used.
 */
export const getAIQuestionService = () => {
  const { apiKey, model } = readConfiguration();

  if (!openAIClient) {
    try {
      openAIClient = new OpenAI({ apiKey });
    } catch {
      throw new AIQuestionConfigurationError(
        "OpenAI client could not be initialized."
      );
    }
  }

  return { client: openAIClient, model };
};

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
  constructor(message = "The AI returned an invalid question set.") {
    super(message);
    this.name = "AIQuestionResponseError";
  }
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

export const generateInterviewQuestions = async ({ candidate, interview, preferences }) => {
  const { client, model } = getAIQuestionService();
  const { count, difficulty, category } = preferences;
  const prompt = `Create exactly ${count} distinct, realistic interview questions for the candidate and interview below.\n\n` +
    `Candidate profile (from the platform):\n- Skills: ${candidate.skills.length ? candidate.skills.join(", ") : "Not provided"}\n` +
    `- Experience: ${candidate.experience} years\n- Target role: ${candidate.targetRole || "Not provided"}\n\n` +
    `Interview:\n- Title: ${interview.title}\n- Category: ${interview.category}\n- Saved difficulty: ${interview.difficulty}\n\n` +
    `Generation preferences:\n- Difficulty: ${difficulty}\n- Question category: ${category}\n\n` +
    `Tailor complexity to the candidate's experience and target role. Avoid repetition and generic trivia. ` +
    `Each expectedAnswer must explain the key concepts of a strong answer with useful detail, not merely say what to include. ` +
    `Return only the required structured data.`;

  let response;
  try {
    response = await client.responses.create({
      model,
      input: [
        { role: "system", content: "You generate high-quality interview practice questions." },
        { role: "user", content: prompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "interview_questions",
          strict: true,
          schema: QUESTION_SCHEMA,
        },
      },
      max_output_tokens: Math.min(12000, 1200 + count * 900),
    });
  } catch (error) {
    if (error?.name === "APIConnectionTimeoutError" || error?.code === "ETIMEDOUT") {
      const timeoutError = new Error("The AI question request timed out.");
      timeoutError.name = "AIQuestionTimeoutError";
      throw timeoutError;
    }
    if (error?.status === 429) {
      const rateError = new Error("The AI question service is rate limited. Please try again shortly.");
      rateError.name = "AIQuestionRateLimitError";
      throw rateError;
    }
    const providerError = new Error("The AI question service is temporarily unavailable.");
    providerError.name = "AIQuestionProviderError";
    throw providerError;
  }

  if (response?.status === "incomplete" || response?.incomplete_details) {
    throw new AIQuestionResponseError("The AI could not complete the requested question set. Please try again.");
  }
  const outputItems = response?.output || [];
  if (outputItems.some((item) => item.type === "message" &&
      item.content?.some((part) => part.type === "refusal"))) {
    throw new AIQuestionResponseError("The AI could not generate questions for this request.");
  }
  if (typeof response?.output_text !== "string" || !response.output_text.trim()) {
    throw new AIQuestionResponseError();
  }

  let parsed;
  try {
    parsed = JSON.parse(response.output_text);
  } catch {
    throw new AIQuestionResponseError();
  }
  return validateQuestions(parsed, count);
};

export { AIQuestionConfigurationError };
