export const RUBRIC_VERSION = "1.0";

const DEFINITIONS = {
  technicalAccuracy: "Correctness of demonstrated technical facts, reasoning, and terminology.",
  relevance: "How directly the answer addresses the question and its stated constraints.",
  completeness: "Coverage of the important parts needed for a useful answer.",
  clarity: "Organization, precision, and ease of understanding.",
};

const RUBRICS = {
  technical: { technicalAccuracy: 45, relevance: 20, completeness: 20, clarity: 15 },
  systemDesign: { technicalAccuracy: 35, relevance: 20, completeness: 30, clarity: 15 },
  behavioral: { relevance: 30, completeness: 35, clarity: 35 },
  general: { technicalAccuracy: 30, relevance: 25, completeness: 25, clarity: 20 },
};

function normalizedWeights(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]));
}

const BEHAVIORAL = /\b(behavioral|behavioural|situational|leadership|conflict|teamwork|tell me about a time|strengths? and weaknesses?)\b/;
const SYSTEM_DESIGN = /\b(system[- ]design|system architecture|architect(?:ure|ing)|design a system|scalab\w*|distributed system)\b/;
const TECHNICAL = /\b(technical|programming|coding|software|database|algorithm|network|security|engineering|javascript|python)\b/;

export function selectEvaluationRubric({ category = "", questionText = "" } = {}) {
  const categoryText = typeof category === "string" ? category.toLowerCase() : "";
  const question = typeof questionText === "string" ? questionText.toLowerCase() : "";
  let type = "general";

  // Explicit labels win over question wording. In mixed labels, behavioral is
  // the safe choice because its rubric has no technical-accuracy dimension.
  if (BEHAVIORAL.test(categoryText)) type = "behavioral";
  else if (SYSTEM_DESIGN.test(categoryText)) type = "systemDesign";
  else if (TECHNICAL.test(categoryText)) type = "technical";
  else if (BEHAVIORAL.test(question)) type = "behavioral";
  else if (SYSTEM_DESIGN.test(question)) type = "systemDesign";
  else if (TECHNICAL.test(question)) type = "technical";

  const weights = normalizedWeights(RUBRICS[type]);
  return {
    type,
    version: RUBRIC_VERSION,
    dimensions: Object.entries(weights).map(([key, weight]) => ({ key, weight, definition: DEFINITIONS[key] })),
    weights,
  };
}

export const RUBRIC_TYPES = Object.freeze(Object.keys(RUBRICS));
