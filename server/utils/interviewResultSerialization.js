/** Remove evaluation internals and reference material from a public result payload. */
export function sanitizeInterviewResult(result, { omitRelations = false } = {}) {
  const plain = result?.toObject ? result.toObject() : { ...result };
  delete plain.evaluationModel;
  delete plain.evaluationPromptVersion;
  delete plain.rubricVersion;
  delete plain.rubricWeights;
  if (omitRelations) {
    delete plain.user;
    delete plain.interview;
  }
  plain.answers = (plain.answers || []).map((answer) => {
    const safeAnswer = answer?.toObject ? answer.toObject() : { ...answer };
    delete safeAnswer.referenceAnswerSnapshot;
    delete safeAnswer.referenceAnswerUsed;
    return safeAnswer;
  });
  return plain;
}
