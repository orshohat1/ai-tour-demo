// Import telemetry FIRST so Azure Monitor auto-instrumentation can hook into
// express and fetch before they are loaded.
import "./telemetry.js";
import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.js";
import summarizeRoutes from "./routes/summarize.js";
import chatRoutes from "./routes/chat.js";
import adminRoutes from "./routes/admin.js";
import inventoryRoutes from "./routes/inventory.js";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(",") ?? [])
  .map((o) => o.trim())
  .filter(Boolean);
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}
if (allowedOrigins.length === 0) {
  console.warn("⚠ No CORS origins configured. All cross-origin requests will be rejected.");
}
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));
app.use(healthRoutes);
app.use(summarizeRoutes);
app.use(chatRoutes);
app.use(adminRoutes);
app.use(inventoryRoutes);

if (!process.env.GITHUB_TOKEN) {
  console.warn("⚠ GITHUB_TOKEN is not set. AI endpoints will not work.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Copilot SDK service listening on port ${PORT}`);
});
