export const getCurrentAdmin = (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      userId: req.user.userId,
      role: req.user.role,
    },
  });
};
import { getAdminDashboardStats } from "../services/adminDashboardStatsService.js";

const TEMPORARY_DATABASE_ERRORS = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoOperationTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoPoolClearedError",
  "MongoWaitQueueTimeoutError",
]);
const TEMPORARY_DATABASE_CODES = new Set([
  6, 7, 50, 89, 91, 189, 262, 10107, 11600, 11602, 13435, 13436,
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT",
]);

function isTemporaryDatabaseFailure(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (
      TEMPORARY_DATABASE_ERRORS.has(current.name) ||
      TEMPORARY_DATABASE_CODES.has(current.code) ||
      (current.name === "MongooseError" && /buffering timed out/i.test(current.message))
    ) return true;
  }
  return false;
}


export const getDashboardStats = async (_req, res) => {
  try {
    const data = await getAdminDashboardStats();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const unavailable = isTemporaryDatabaseFailure(error);
    console.error("Administrator dashboard statistics failed.", {
      category: unavailable ? "database_unavailable" : "query_error",
    });
    return res.status(unavailable ? 503 : 500).json({
      success: false,
      message: "Failed to retrieve administrator dashboard statistics.",
    });
  }
};
