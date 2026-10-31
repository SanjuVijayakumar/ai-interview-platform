import express from "express";
import { loginUser, registerUser, updateUserProfile } from "../controllers/authController.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

// POST /api/auth/register
router.post("/register", registerUser);

// POST /api/auth/login
router.post("/login", loginUser);

// GET /api/auth/profile - (protectd route)
router.get("/profile", authMiddleware, (req, res) => {
    res.status(200).json({
    success: true,
    message: "Access granted to protected route",
    user: req.user,
  });
});

router.patch("/profile", authMiddleware, updateUserProfile);

export default router;
