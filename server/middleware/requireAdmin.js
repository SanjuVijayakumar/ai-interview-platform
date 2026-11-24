import mongoose from "mongoose";

const requireAdmin = (req, res, next) => {
  const user = req.user;

  if (
    !user ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof user.userId !== "string" ||
    !mongoose.isObjectIdOrHexString(user.userId)
  ) {
    return res.status(401).json({
      success: false,
      message: "Authentication is required.",
    });
  }

  if (user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Administrator privileges are required.",
    });
  }

  return next();
};

export default requireAdmin;
