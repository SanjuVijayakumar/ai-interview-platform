import express from "express";
import mongoose from "mongoose";
import Interview from "../models/Interview.js";
import InterviewResult from "../models/InterviewResult.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authMiddleware);

router.get("/stats", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid authentication token." });
    }

    const userId = new mongoose.Types.ObjectId(req.user.userId);
    const interviews = await Interview.find({ user: userId }).select("_id").lean();
    const interviewIds = interviews.map((interview) => interview._id);

    if (interviewIds.length === 0) {
      return res.status(200).json({
        totalInterviews: 0,
        completedInterviews: 0,
        pendingInterviews: 0,
        averageScore: null,
      });
    }

    const completedSessions = await InterviewResult.find({
      user: userId,
      interview: { $in: interviewIds },
      status: "completed",
    })
      .select("interview evaluationStatus overallScore")
      .lean();

    const completedInterviewIds = new Set();
    const scores = [];

    for (const session of completedSessions) {
      completedInterviewIds.add(String(session.interview));

      if (
        session.evaluationStatus === "completed" &&
        typeof session.overallScore === "number" &&
        Number.isFinite(session.overallScore) &&
        session.overallScore >= 0 &&
        session.overallScore <= 100
      ) {
        scores.push(session.overallScore);
      }
    }

    const totalInterviews = interviews.length;
    const completedInterviewCount = completedInterviewIds.size;
    // Scores are nonnegative; Math.round therefore resolves exact half-tenths upward.
    const averageScore = scores.length
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
      : null;

    return res.status(200).json({
      totalInterviews,
      completedInterviews: completedInterviewCount,
      pendingInterviews: totalInterviews - completedInterviewCount,
      averageScore,
    });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to retrieve dashboard statistics" });
  }
});

export default router;
