import mongoose from "mongoose";
import Interview from "../models/Interview.js";
import User from "../models/User.js";
import {
  AIQuestionConfigurationError,
  AIQuestionResponseError,
  generateInterviewQuestions,
} from "../services/aiQuestionService.js";

const DIFFICULTIES = new Set(["Beginner", "Intermediate", "Advanced"]);
const ALLOWED_FIELDS = new Set(["count", "difficulty", "category"]);

export const generateQuestions = async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!mongoose.isValidObjectId(interviewId)) {
      return res.status(400).json({ success: false, message: "Invalid interview ID." });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
      return res.status(400).json({ success: false, message: "Request body contains invalid fields." });
    }
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 10) {
      return res.status(400).json({ success: false, message: "Count must be an integer from 1 to 10." });
    }
    if (body.difficulty !== undefined && !DIFFICULTIES.has(body.difficulty)) {
      return res.status(400).json({ success: false, message: "Difficulty must be Beginner, Intermediate, or Advanced." });
    }
    if (body.category !== undefined && (typeof body.category !== "string" ||
        !body.category.trim() || body.category.trim().length > 60)) {
      return res.status(400).json({ success: false, message: "Category must be a non-empty string of at most 60 characters." });
    }

    const interview = await Interview.findOne({ _id: interviewId, user: req.user.userId });
    if (!interview) {
      return res.status(404).json({ success: false, message: "Interview not found." });
    }
    if (!interview.title?.trim() || !interview.category?.trim() || !DIFFICULTIES.has(interview.difficulty)) {
      return res.status(400).json({ success: false, message: "The interview is missing required generation information." });
    }

    const user = await User.findById(req.user.userId).select("skills experience targetRole");
    if (!user) return res.status(404).json({ success: false, message: "User profile not found." });

    const difficulty = body.difficulty ?? interview.difficulty;
    const category = body.category?.trim() ?? interview.category;
    const questions = await generateInterviewQuestions({
      candidate: {
        skills: Array.isArray(user.skills) ? user.skills : [],
        experience: Number.isFinite(user.experience) ? user.experience : 0,
        targetRole: typeof user.targetRole === "string" ? user.targetRole : "",
      },
      interview: { title: interview.title, category: interview.category, difficulty: interview.difficulty },
      preferences: { count: body.count, difficulty, category },
    });

    return res.status(200).json({ success: true, interviewId: interview._id.toString(), questions });
  } catch (error) {
    if (error instanceof AIQuestionConfigurationError) {
      return res.status(503).json({ success: false, message: error.message });
    }
    if (error instanceof AIQuestionResponseError) {
      return res.status(502).json({ success: false, message: error.message });
    }
    if (error?.name === "AIQuestionRateLimitError") {
      return res.status(429).json({ success: false, message: error.message });
    }
    if (error?.name === "AIQuestionTimeoutError") {
      return res.status(504).json({ success: false, message: error.message });
    }
    if (error?.name === "AIQuestionProviderError") {
      return res.status(502).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to generate interview questions." });
  }
};
