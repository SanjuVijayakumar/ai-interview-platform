import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import connectDB from "./config/db.js";
import interviewRoutes from "./routes/interviewRoutes.js";
import User from "./models/User.js";
import questionRoutes from "./routes/questionRoutes.js";
import resultRoutes from "./routes/resultRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: "http://localhost:5173",
}));
app.use(express.json());

// Root route
app.get("/", (req, res) => {
    res.json({
    message: "AI Interview Preparation Platform API is running!",
    });
});

// Health-check API
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend server is running",
  });
});

// Register API routes
app.use("/api/interviews", interviewRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/results", resultRoutes);

app.post("/api/test-user", async (req, res) => {
  try {
    let user = await User.findOne({
      email: "testuser@example.com",
    });

    if (!user) {
      user = await User.create({
        name: "Test User",
        email: "testuser@example.com",
        password: "temporary-password-123",
      });
    }

    res.status(201).json({
      success: true,
      message: "Test user created or already exists",
      userId: user._id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Start server after connctng  to MongoDB
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();