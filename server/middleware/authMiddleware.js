import jwt from "jsonwebtoken";

const authMiddleware = (req, res, next) => {
  try {
    // Reading Authorization header
    const authHeader = req.headers.authorization;

    // Check whether the Bearer token exists
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access denied. Authentication token is required.",
      });
    }

    // Extract the token
    const token = authHeader.split(" ")[1];

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach the authenticated user's information to the request
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
    };

    // Continue to the next middleware or route handler
    next();
  } catch (error) {
    // Handle invalid or expired tokens
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Authentication token has expired. Please log in again.",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid authentication token.",
    });
  }
};

export default authMiddleware;