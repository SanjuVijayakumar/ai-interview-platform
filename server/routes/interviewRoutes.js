import express from "express";
import mongoose from "mongoose";
import Interview from "../models/Interview.js";

const router = express.Router();

// POST: Create a new interview
router.post("/", async (req, res) => {
  try {
    const {
      user,
      title,
      category,
      difficulty,
    } = req.body;

    if (!user || !title || !category || !difficulty) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    if (!mongoose.isValidObjectId(user)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const interview = await Interview.create({
      user,
      title,
      category,
      difficulty,
    });

    res.status(201).json({
      success: true,
      message: "Interview created successfully",
      interview,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Retrieve all interviews
router.get("/", async (req, res) => {
  try {
    const interviews = await Interview.find().sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: interviews.length,
      interviews,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch interviews",
    });
  }
});

// PATCH: Update an existing interview
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate the interview ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // Allow only specific fields to be updated
    const allowedFields = [
      "title",
      "category",
      "difficulty",
      "status",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Check whether valid fields were provided
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one valid field to update",
      });
    }

    // Update the interview in MongoDB
    const interview = await Interview.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    // Check whether the interview exists
    if (!interview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // Return the updated interview
    res.status(200).json({
      success: true,
      message: "Interview updated successfully",
      interview,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update interview",
    });
  }
});

// DELETE: Delete an interview by ID
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate the interview ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // 2. Find and delete the interview
    const interview = await Interview.findByIdAndDelete(id);

    // 3. Check whether the interview exists
    if (!interview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // 4. Return success response
    res.status(200).json({
      success: true,
      message: "Interview deleted successfully",
      interview,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete interview",
    });
  }
});

// Retrieve one interview by ID
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    const interview = await Interview.findById(id);

    if (!interview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    res.status(200).json({
      success: true,
      interview,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch interview",
    });
  }
});

export default router;