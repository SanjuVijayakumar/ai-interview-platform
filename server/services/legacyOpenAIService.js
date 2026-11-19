import { createRequire } from "node:module";

let openAIClient;
const require = createRequire(import.meta.url);

/** Legacy OpenAI client for answer evaluation until that service is migrated. */
export const getLegacyOpenAIService = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  if (!apiKey) {
    const error = new Error("OpenAI API configuration is unavailable.");
    error.name = "AIQuestionConfigurationError";
    throw error;
  }
  if (!model || /\s/.test(model)) {
    const error = new Error("OpenAI model configuration is invalid.");
    error.name = "AIQuestionConfigurationError";
    throw error;
  }

  if (!openAIClient) {
    try {
      const OpenAI = require("openai");
      openAIClient = new OpenAI({ apiKey });
    } catch {
      const error = new Error("OpenAI client could not be initialized.");
      error.name = "AIQuestionConfigurationError";
      throw error;
    }
  }
  return { client: openAIClient, model };
};
