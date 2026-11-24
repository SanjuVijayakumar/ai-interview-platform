import express from "express";
import { getCurrentAdmin } from "../controllers/adminController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";

const router = express.Router();

router.use(authMiddleware, requireAdmin);

router.get("/me", getCurrentAdmin);

export default router;
