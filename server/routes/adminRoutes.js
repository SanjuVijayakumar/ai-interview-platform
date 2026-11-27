import express from "express";
import { getCurrentAdmin, getDashboardStats } from "../controllers/adminController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";

const router = express.Router();

router.use("/dashboard/stats", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(authMiddleware, requireAdmin);

router.get("/me", getCurrentAdmin);
router.get("/dashboard/stats", getDashboardStats);

export default router;
