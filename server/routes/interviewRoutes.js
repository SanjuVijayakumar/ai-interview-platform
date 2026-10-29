import express from "express";
import mongoose from "mongoose";
import Interview from "../models/Interview.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

// POST: Create a new interview
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { title, category, difficulty } = req.body;
    const user = req.user.userId;

    if ( !title || !category || !difficulty) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
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

// Retrieve all interviews - authenticated user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const interviews = await Interview.find({
      user: req.user.userId,
    }).sort({ createdAt: -1 });

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


// PATCH: Update an interview belonging to the authenticated user
router.patch("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate the interview ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // 2. Allow only specific fields to be updated
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

    // 3. Check whether valid fields were provided
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one valid field to update",
      });
    }

    // 4. Update only an interview owned by the authenticated user
    const interview = await Interview.findOneAndUpdate(
      {
        _id: id,
        user: req.user.userId,
      },
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    // 5. Check whether the interview exists and belongs to the user
    if (!interview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // 6. Return the updated interview
    return res.status(200).json({
      success: true,
      message: "Interview updated successfully",
      interview,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update interview",
    });
  }
});

// DELETE: Delete an interview belonging to the authenticated user
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate the interview ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid interview ID",
      });
    }

    // 2. Delete only an interview owned by the authenticated user
    const interview = await Interview.findOneAndDelete({
      _id: id,
      user: req.user.userId,
    });

    // 3. Check whether the interview exists and belongs to the user
    if (!interview) {
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      });
    }

    // 4. Return success response
    return res.status(200).json({
      success: true,
      message: "Interview deleted successfully",
      interview,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete interview",
    });
  }
});

// Retrieve one interview by ID
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate the interview ID
    if (!mongoose.isValidObjectId(id)) { 
      return res.status(400).json({ 
        success: false, 
        message: "Invalid interview ID",
      }); 
    }

    // 2. Find the interview owned by the authenticated user
    const interview = await Interview.findOne({ 
      _id: id, 
      user: req.user.userId, 
    });

    // 3. Check whether the interview exists and belongs to the user
    if (!interview) {
      return res.status(404).json({ 
        success: false, 
        message: "Interview not found", 
      });
    }

    // 4. Return the interview
    return res.status(200).json({ 
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