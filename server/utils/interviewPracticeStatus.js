import InterviewResult from "../models/InterviewResult.js";

export async function getInterviewPracticeStatuses(interviewIds, userId) {
  const statusesByInterview = new Map();
  if (interviewIds.length === 0) return statusesByInterview;

  const sessions = await InterviewResult.find({
    user: userId,
    interview: { $in: interviewIds },
    status: { $in: ["completed", "in-progress"] },
  })
    .select("interview status")
    .lean();

  for (const session of sessions) {
    const interviewId = String(session.interview);
    if (session.status === "completed" || statusesByInterview.get(interviewId) !== "completed") {
      statusesByInterview.set(interviewId, session.status);
    }
  }

  return statusesByInterview;
}
