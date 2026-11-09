import express from "express";
import mongoose from "mongoose";
import InterviewResult from "../models/InterviewResult.js";
import Interview from "../models/Interview.js";
import Question from "../models/Question.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authMiddleware);

const hasOnlyKeys = (value, allowed) =>
  value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

function sendValidationError(res, error) {
  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({ success: false, message: error.message });
  }
  return res.status(500).json({ success: false, message: "Failed to process interview result" });
}

// Create a result for the authenticated user. Question data is snapshotted server-side.
router.post("/", async (req, res) => {
  try {
    if (!hasOnlyKeys(req.body, ["interview", "answers"])) {
      return res.status(400).json({ success: false, message: "Only interview and answers may be provided" });
    }
    const { interview, answers } = req.body;
    if (!mongoose.isValidObjectId(interview) || !Array.isArray(answers)) {
      return res.status(400).json({ success: false, message: "A valid interview ID and answers array are required" });
    }
    const existingInterview = await Interview.findOne({ _id: interview, user: req.user.userId });
    if (!existingInterview) {
      return res.status(404).json({ success: false, message: "Interview not found" });
    }
    const questions = await Question.find({ interview }).sort({ order: 1 });
    const suppliedAnswers = new Map();
    for (const answer of answers) {
      if (!hasOnlyKeys(answer, ["question", "answerText"]) ||
          !mongoose.isValidObjectId(answer.question) ||
          (answer.answerText !== undefined && typeof answer.answerText !== "string")) {
        return res.status(400).json({ success: false, message: "Each answer must contain a valid question ID and optional answer text" });
      }
      const questionId = String(answer.question);
      if (suppliedAnswers.has(questionId)) {
        return res.status(400).json({ success: false, message: "Duplicate question IDs are not allowed" });
      }
      suppliedAnswers.set(questionId, answer.answerText || "");
    }
    const questionIds = new Set(questions.map((question) => String(question._id)));
    if ([...suppliedAnswers.keys()].some((id) => !questionIds.has(id))) {
      return res.status(400).json({ success: false, message: "Answers must reference questions in this interview" });
    }

    const result = await InterviewResult.create({
      user: req.user.userId,
      interview,
      totalQuestions: questions.length,
      startedAt: new Date(),
      status: "in-progress",
      answers: questions.map((question) => ({
        question: question._id,
        questionText: question.questionText,
        category: question.category,
        difficulty: question.difficulty,
        order: question.order,
        answerText: suppliedAnswers.get(String(question._id)) || "",
      })),
    });
    return res.status(201).json({ success: true, message: "Interview result created successfully", result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.get("/", async (req, res) => {
  try {
    const results = await InterviewResult.find({ user: req.user.userId })
      .populate("interview", "title category difficulty")
      .sort({ createdAt: -1 });
    return res.status(200).json({ success: true, count: results.length, results });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to retrieve interview results" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid interview result ID" });
    }
    const result = await InterviewResult.findOne({ _id: id, user: req.user.userId })
      .populate("interview", "title category difficulty");
    if (!result) return res.status(404).json({ success: false, message: "Interview result not found" });
    return res.status(200).json({ success: true, result });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to retrieve interview result" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid interview result ID" });
    }
    if (!hasOnlyKeys(req.body, ["answers"]) || !Array.isArray(req.body.answers) || req.body.answers.length === 0) {
      return res.status(400).json({ success: false, message: "Only a non-empty answers array may be updated" });
    }
    const result = await InterviewResult.findOne({ _id: id, user: req.user.userId });
    if (!result) return res.status(404).json({ success: false, message: "Interview result not found" });
    if (result.status === "completed") {
      return res.status(409).json({ success: false, message: "Completed interview results cannot be modified" });
    }

    const requested = new Map();
    for (const answer of req.body.answers) {
      if (!hasOnlyKeys(answer, ["question", "answerText"]) ||
          !mongoose.isValidObjectId(answer.question) || typeof answer.answerText !== "string") {
        return res.status(400).json({ success: false, message: "Each update must contain a valid question ID and answer text" });
      }
      const questionId = String(answer.question);
      if (requested.has(questionId)) return res.status(400).json({ success: false, message: "Duplicate question IDs are not allowed" });
      requested.set(questionId, answer.answerText);
    }
    const snapshotIds = new Set(result.answers.map((answer) => String(answer.question)));
    if ([...requested.keys()].some((questionId) => !snapshotIds.has(questionId))) {
      return res.status(400).json({ success: false, message: "Answers must reference questions in this result" });
    }
    for (const answer of result.answers) {
      if (requested.has(String(answer.question))) answer.answerText = requested.get(String(answer.question));
    }
    await result.save();
    await result.populate("interview", "title category difficulty");
    return res.status(200).json({ success: true, message: "Interview result updated successfully", result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid interview result ID" });
    }
    const result = await InterviewResult.findOneAndDelete({
      _id: id,
      user: req.user.userId,
      status: { $ne: "completed" },
    });
    if (!result) {
      const ownedResult = await InterviewResult.exists({ _id: id, user: req.user.userId });
      if (!ownedResult) return res.status(404).json({ success: false, message: "Interview result not found" });
      return res.status(409).json({ success: false, message: "Completed interview results cannot be modified" });
    }
    return res.status(200).json({ success: true, message: "Interview result deleted successfully", resultId: result._id });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to delete interview result" });
  }
});

export default router;
