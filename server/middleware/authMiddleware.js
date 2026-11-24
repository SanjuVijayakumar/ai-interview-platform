import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";

const SUPPORTED_ROLES = new Set(["user", "admin"]);
const DATABASE_CONNECTIVITY_ERROR_NAMES = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoPoolClearedError",
  "MongoWaitQueueTimeoutError",
]);
const DATABASE_CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function sendInvalidToken(res) {
  return res.status(401).json({
    success: false,
    message: "Invalid authentication token.",
  });
}

function isDatabaseConnectivityError(error) {
  const seen = new Set();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (
      DATABASE_CONNECTIVITY_ERROR_NAMES.has(current.name) ||
      DATABASE_CONNECTIVITY_ERROR_CODES.has(current.code) ||
      (current.name === "MongooseError" &&
        typeof current.message === "string" &&
        /buffering timed out/i.test(current.message))
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Access denied. Authentication token is required.",
    });
  }

  const token = authHeader.slice("Bearer ".length);
  if (!token || token.trim() !== token || /\s/.test(token)) {
    return sendInvalidToken(res);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Authentication token has expired. Please log in again.",
      });
    }
    return sendInvalidToken(res);
  }

  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    typeof decoded.userId !== "string" ||
    !mongoose.isObjectIdOrHexString(decoded.userId)
  ) {
    return sendInvalidToken(res);
  }

  let user;
  try {
    user = await User.findById(decoded.userId).select("_id role").lean();
  } catch (error) {
    const unavailable = isDatabaseConnectivityError(error);
    console.error("Authentication user lookup failed.", {
      category: unavailable ? "database_unavailable" : "database_error",
    });
    return res.status(unavailable ? 503 : 500).json({
      success: false,
      message: unavailable
        ? "Authentication service is temporarily unavailable. Please try again."
        : "Internal server error while authenticating.",
    });
  }

  if (
    !user ||
    !mongoose.isObjectIdOrHexString(user._id) ||
    user._id.toString().toLowerCase() !== decoded.userId.toLowerCase() ||
    !SUPPORTED_ROLES.has(user.role)
  ) {
    return sendInvalidToken(res);
  }

  req.user = {
    userId: user._id.toString(),
    role: user.role,
  };

  return next();
};

export default authMiddleware;
