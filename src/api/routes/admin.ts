import { Router } from "express";
import { resetStore } from "../data/store.js";

const router = Router();

// Reset the seeded backend to its initial state. Used between recording takes
// so every run of the demo starts from identical data. Guarded by a token when
// ADMIN_RESET_TOKEN is set; open only when it is not (local/dev convenience).
router.post("/admin/reset", (req, res) => {
  const required = process.env.ADMIN_RESET_TOKEN;
  if (required) {
    const provided = req.header("x-admin-token");
    if (provided !== required) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  resetStore();
  res.json({ ok: true, message: "Backend reset to seeded state" });
});

export default router;
