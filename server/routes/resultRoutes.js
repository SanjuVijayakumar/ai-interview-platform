import express from "express";
import mongoose from "mongoose";

import InterviewResult from "../models/InterviewResult.js";
import User from "../models/User.js";
import Interview from "../models/Interview.js";
import Question from "../models/Question.js";

const router = express.Router();

// POST: Create an interview result
router.post("/", async (req, res) => {
  try {
    const {
      user,
      interview,
      answers,
      totalScore,
      overallFeedback,
      status,
    } = req.body;

    // Validate required fields
    if (!user || !interview || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: "User, interview, and answers are required",
      });
    }

    // Validate User ID
    if (!mongoose.isValidObjectId(user)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    // Validate Interview ID
    if (!mongoose.isValidObjectId(interview)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // Check whether the user exists
    const existingUser = await User.findById(user);

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check whether the interview exists
    const existingInterview = await Interview.findById(interview);

    if (!existingInterview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // Validate each answer
    for (const answer of answers) {
      if (!mongoose.isValidObjectId(answer.question)) {
        return res.status(400).json({
          success: false,
          message: "Invalid question ID in answers",
        });
      }

      const existingQuestion = await Question.findOne({
        _id: answer.question,
        interview,
      });

      if (!existingQuestion) {
        return res.status(404).json({
          success: false,
          message: "Question not found in this interview",
        });
      }
    }

    // Create the interview result
    const result = await InterviewResult.create({
      user,
      interview,
      answers,
      totalQuestions: answers.length,
      totalScore,
      overallFeedback,
      status,
      ...(status === "completed"
        ? { completedAt: new Date() }
        : {}),
    });

    res.status(201).json({
      success: true,
      message: "Interview result created successfully",
      result,
    });
  } catch (error) {
    if (
      error.name === "ValidationError" ||
      error.name === "CastError"
    ) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create interview result",
    });
  }
});


// GET: Retrieve all interview results
router.get("/", async (req, res) => {
  try {
    const results = await InterviewResult.find()
      .populate("user", "name email")
      .populate("interview", "title category difficulty")
      .populate("answers.question", "questionText category difficulty")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: results.length,
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to retrieve interview results",
    });
  }
});

export default router;