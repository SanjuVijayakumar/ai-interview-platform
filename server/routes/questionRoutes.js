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

// PATCH: Update an existing question
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { questionText, category, difficulty, expectedAnswer, order } = req.body;

    // Validate Question ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid question ID",
      });
    }

    // Allow only these fields to be updated
    const allowedFields = [
      "questionText",
      "category",
      "difficulty",
      "expectedAnswer",
      "order",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Check whether there are fields to update
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    // Validate required text fields when provided
    if (
      updates.questionText !== undefined &&
      (typeof updates.questionText !== "string" ||
        !updates.questionText.trim())
    ) {
      return res.status(400).json({
        success: false,
        message: "Question text cannot be empty",
      });
    }

    if (
      updates.category !== undefined &&
      (typeof updates.category !== "string" || !updates.category.trim())
    ) {
      return res.status(400).json({
        success: false,
        message: "Category cannot be empty",
      });
    }

    // Update the question
    const question = await Question.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    // Check whether the question exists
    if (!question) {
      return res.status(404).json({
        success: false,
        message: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Question updated successfully",
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
      message: "Failed to update question",
    });
  }
});


// DELETE: Delete an existing question
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate Question ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid question ID",
      });
    }

    // Find and delete the question
    const question = await Question.findByIdAndDelete(id);

    // Check whether the question exists
    if (!question) {
      return res.status(404).json({
        success: false,
        message: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Question deleted successfully",
      questionId: question._id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete question",
    });
  }
});

export default router;