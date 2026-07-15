import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { runPipeline, reportIdForFile } from "./pipeline.js";
import { generateReport, loadReport } from "./reportGenerator.js";
import { handleChat } from "./chatAgent.js";
import { ROOT, REPORTS_DIR, SAMPLES_DIR, UPLOADS_DIR, loadChecklists } from "./lib/config.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, file.originalname.replace(/[^a-zA-Z0-9-_.]+/g, "-")),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---- In-memory job store (verification runs take minutes) ----
const jobs = new Map();
let jobSeq = 0;

function startJob(pdfPath, options = {}) {
  const jobId = String(++jobSeq);
  const job = { id: jobId, status: "running", log: [], reportId: null, error: null };
  jobs.set(jobId, job);
  (async () => {
    try {
      const state = await runPipeline(pdfPath, {
        ...options,
        onProgress: (msg) => job.log.push({ t: new Date().toISOString(), msg }),
      });
      job.reportId = state.id;
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      job.log.push({ t: new Date().toISOString(), msg: `FAILED: ${err.message}` });
    }
  })();
  return jobId;
}

// ---- API ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.get("/api/config", (_req, res) => res.json(loadChecklists()));

app.get("/api/samples", (_req, res) => {
  const files = fs.existsSync(SAMPLES_DIR)
    ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"))
    : [];
  res.json(files.map((f) => ({ file: f, reportId: reportIdForFile(f) })));
});

app.get("/api/reports", (_req, res) => {
  const dirs = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter((d) => fs.existsSync(path.join(REPORTS_DIR, d, "report.json")))
    : [];
  const list = dirs.map((d) => {
    const r = loadReport(path.join(REPORTS_DIR, d));
    return {
      id: d,
      participant: r.parsed?.participantName,
      requested: r.parsed?.requestedItem,
      provider: r.parsed?.providerName,
      category: r.category?.label,
      reviewDate: r.meta?.reviewDate,
      needsClarification: r.needsClarification || false,
    };
  });
  res.json(list);
});

app.get("/api/reports/:id", (req, res) => {
  const dir = path.join(REPORTS_DIR, path.basename(req.params.id));
  if (!fs.existsSync(path.join(dir, "report.json"))) return res.status(404).json({ error: "not found" });
  res.json(loadReport(dir));
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
  res.json({ file: `uploads/${req.file.filename}` });
});

app.post("/api/verify", (req, res) => {
  const { file, categoryOverride, urlOverride } = req.body || {};
  if (!file) return res.status(400).json({ error: "file is required (samples/... or uploads/...)" });
  const abs = path.resolve(ROOT, file);
  if (!abs.startsWith(SAMPLES_DIR) && !abs.startsWith(UPLOADS_DIR)) {
    return res.status(400).json({ error: "file must live in samples/ or uploads/" });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: `not found: ${file}` });
  const jobId = startJob(abs, { categoryOverride, urlOverride });
  res.json({ jobId });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.json(job);
});

app.post("/api/chat", async (req, res) => {
  const { reportId, message } = req.body || {};
  if (!reportId || !message) return res.status(400).json({ error: "reportId and message are required" });
  const dir = path.join(REPORTS_DIR, path.basename(reportId));
  if (!fs.existsSync(path.join(dir, "report.json"))) return res.status(404).json({ error: "report not found" });
  try {
    const result = await handleChat(dir, message, { startJob });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve generated report bundles (HTML + screenshots) and built client
app.use("/reports", express.static(REPORTS_DIR));
const clientDist = path.join(ROOT, "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/reports).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Pre-Approval Verification Tool API on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("WARNING: GEMINI_API_KEY not set — copy .env.example to .env and add your key.");
  }
});
