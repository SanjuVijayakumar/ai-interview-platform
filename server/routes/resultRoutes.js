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


// GET: Retrieve a single interview result by ID
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate Result ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview result ID",
      });
    }

    // Find the interview result
    const result = await InterviewResult.findById(id)
      .populate("user", "name email")
      .populate("interview", "title category difficulty")
      .populate(
        "answers.question",
        "questionText category difficulty"
      );

    // Check whether the result exists
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Interview result not found",
      });
    }

    res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to retrieve interview result",
    });
  }
});

// PATCH: Update an existing interview result
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate Result ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview result ID",
      });
    }

    // Allow only specific fields to be updated
    const allowedFields = [
      "answers",
      "totalScore",
      "overallFeedback",
      "status",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Check whether there are valid fields to update
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    // Validate answers if provided
    if (updates.answers !== undefined && !Array.isArray(updates.answers)) {
      return res.status(400).json({
        success: false,
        message: "Answers must be an array",
      });
    }

    // Set completion date when status becomes completed
    if (updates.status === "completed") {
      updates.completedAt = new Date();
    }

    // Update the result
    const result = await InterviewResult.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    )
      .populate("user", "name email")
      .populate("interview", "title category difficulty")
      .populate(
        "answers.question",
        "questionText category difficulty"
      );

    // Check whether the result exists
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Interview result not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Interview result updated successfully",
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
      message: "Failed to update interview result",
    });
  }
});

export default router;