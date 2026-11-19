import { AIProviderError, invalidProviderOutput, normalizeProviderError } from "./normalizeProviderError.js";

function inspectResponse(response, model) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const refused = output.some((item) => item.type === "message" &&
    item.content?.some((part) => part.type === "refusal"));
  const incomplete = response?.status === "incomplete" || Boolean(response?.incomplete_details);
  if (refused || incomplete) {
    return { text: "", model, provider: "openai", refused, incomplete };
  }

  const text = typeof response?.output_text === "string" ? response.output_text.trim() : "";
  if (!text) throw invalidProviderOutput("invalid_output");
  try { JSON.parse(text); } catch { throw invalidProviderOutput("invalid_output"); }
  return { text, model, provider: "openai", refused: false, incomplete: false };
}

export async function createAIAdapter({ apiKey, model, timeoutMs, client: injectedClient } = {}) {
  if (!apiKey || !model) throw invalidProviderOutput("configuration");
  let client = injectedClient;
  if (!client) {
    try {
      const { default: OpenAI } = await import("openai");
      client = new OpenAI({ apiKey, timeout: timeoutMs });
    } catch {
      throw new AIProviderError("provider_unavailable");
    }
  }

  return {
    async generate({ systemInstruction, userPrompt, responseSchema, maxOutputTokens, timeoutMs: requestTimeoutMs } = {}) {
      let response;
      try {
        response = await client.responses.create({
          model,
          input: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "structured_response",
              strict: true,
              schema: responseSchema,
            },
          },
          max_output_tokens: maxOutputTokens,
        }, requestTimeoutMs ? { timeout: requestTimeoutMs } : undefined);
      } catch (error) {
        throw normalizeProviderError(error, { timeoutMs: requestTimeoutMs ?? timeoutMs, provider: "openai" });
      }
      return inspectResponse(response, model);
    },
  };
}

export { inspectResponse as inspectOpenAIResponse };
