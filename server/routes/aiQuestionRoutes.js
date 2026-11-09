import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import { generateQuestions } from "../controllers/aiQuestionController.js";

const router = express.Router();

router.post("/:interviewId/generate-questions", authMiddleware, generateQuestions);

export default router;
