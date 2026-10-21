import express from "express";
import mongoose from "mongoose";
import Question from "../models/Question.js";
import Interview from "../models/Interview.js";

const router = express.Router();

// POST: Create a new question
router.post("/", async (req, res) => {
  try {
    const {
      interview,
      questionText,
      category,
      difficulty,
      expectedAnswer,
      order,
    } = req.body;

    // validate required fields
    if (
      !interview || !questionText?.trim() || !category?.trim() || !difficulty || order === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be provided",
      });
    }

    // validate interview ID
    if (!mongoose.isValidObjectId(interview)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // check whether the interview exists
    const existingInterview = await Interview.findById(interview);

    if (!existingInterview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // create question
    const question = await Question.create({
      interview,
      questionText,
      category,
      difficulty,
      expectedAnswer,
      order,
    });

    // return created question
    res.status(201).json({
      success: true,
      message: "Question created successfully",
      question,
    });
  } catch (error) {
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create question",
    });
  }
});

// GET: Retrieve all questions for a specific interview
router.get("/:interviewId", async (req, res) => {
  try {
    const { interviewId } = req.params;

    // Validate Interview ID
    if (!mongoose.isValidObjectId(interviewId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // Check whether the interview exists
    const existingInterview = await Interview.findById(interviewId);

    if (!existingInterview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // Retrieve questions belonging to this interview
    const questions = await Question.find({
      interview: interviewId,
    }).sort({ order: 1 });

    res.status(200).json({
      success: true,
      count: questions.length,
      questions,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to retrieve questions",
    });
  }
});

export default router;