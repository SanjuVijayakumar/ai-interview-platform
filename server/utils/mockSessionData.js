export function createSessionAnswerSnapshots(questions) {
  return questions.map((question) => ({
    question: question._id,
    questionText: question.questionText,
    referenceAnswerSnapshot: typeof question.expectedAnswer === "string" ? question.expectedAnswer : "",
    category: question.category,
    difficulty: question.difficulty,
    order: question.order,
    answerText: "",
  }));
}

export function sessionPayload(session) {
  return {
    _id: session._id,
    interview: session.interview,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationSeconds: session.durationSeconds,
    totalQuestions: session.totalQuestions,
    answers: session.answers.map((answer) => ({
      question: answer.question,
      questionText: answer.questionText,
      category: answer.category,
      difficulty: answer.difficulty,
      order: answer.order,
      answerText: answer.answerText,
    })),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
