import path from "path";
import fs from "fs";
import { parseApplication } from "./pdfParser.js";
import { runResearch, captureTargetedEvidence } from "./researchAgent.js";
import { evaluateChecklist } from "./checklistEvaluator.js";
import { generateReport } from "./reportGenerator.js";
import { resolveCategory, REPORTS_DIR } from "./lib/config.js";
import { getModelName } from "./lib/gemini.js";

export function reportIdForFile(pdfPath) {
  return path
    .basename(pdfPath, ".pdf")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/**
 * Full workflow: parse PDF -> research website -> evaluate checklist ->
 * targeted captures -> report bundle in reports/<id>/.
 * Returns the report state. `onProgress(msg)` streams status updates.
 */
export async function runPipeline(pdfPath, { onProgress = () => {}, categoryOverride, urlOverride } = {}) {
  const id = reportIdForFile(pdfPath);
  const outDir = path.join(REPORTS_DIR, id);
  fs.mkdirSync(outDir, { recursive: true });

  onProgress("Parsing application PDF with Gemini...");
  const parsed = await parseApplication(pdfPath);
  if (urlOverride) {
    parsed.url = urlOverride;
    parsed.missingInfo = parsed.missingInfo.filter((m) => !/URL/i.test(m));
  }
  if (categoryOverride) {
    parsed.category = categoryOverride;
    parsed.missingInfo = parsed.missingInfo.filter((m) => !/category/i.test(m));
  }
  onProgress(`Parsed: ${parsed.requestedItem} from ${parsed.providerName} (${parsed.category})`);

  const category = resolveCategory(parsed.category);
  if (!category) {
    // Cannot proceed without a checklist — produce a clarification-only report.
    const state = {
      id,
      parsed,
      category: { key: "unknown", label: "Unknown — reviewer must select a checklist", webChecks: [] },
      findings: [],
      rateComparison: { formRate: parsed.statedFee, websiteRate: "", verdict: "not published", note: "Review not run: category unknown." },
      internalItems: [],
      pages: [],
      appealAssessment: "",
      reviewerNotes: [],
      meta: buildMeta(pdfPath),
      needsClarification: true,
    };
    generateReport(state, outDir);
    return state;
  }

  let pages = [];
  let headed = false;
  if (parsed.url) {
    onProgress(`Researching ${parsed.url} ...`);
    const research = await runResearch(parsed, category, outDir, onProgress);
    pages = research.pages;
    headed = research.headed;
    if (research.blocked) {
      onProgress("Warning: the site appears to block automated browsers; findings will be conservative.");
    }
  } else {
    onProgress("No URL on the form — skipping website research (clarification needed).");
  }

  onProgress("Evaluating checklist against captured evidence...");
  const evaluation = await evaluateChecklist(parsed, category, pages);

  onProgress("Capturing targeted, labeled evidence screenshots...");
  try {
    await captureTargetedEvidence(evaluation.findings, outDir, onProgress, headed, pages.map((p) => p.url));
  } catch (err) {
    onProgress(`Targeted capture phase failed: ${err.message} — report will use whole-page captures only.`);
  }

  const state = {
    id,
    parsed,
    category,
    findings: evaluation.findings,
    rateComparison: evaluation.rateComparison,
    internalItems: evaluation.internalItems,
    appealAssessment: evaluation.appealAssessment,
    pages: pages.map(({ links, text, ...keep }) => keep), // keep report.json lean
    pageTexts: pages.map((p) => ({ url: p.url, text: p.text })), // kept for chat re-evaluation
    reviewerNotes: [],
    meta: buildMeta(pdfPath),
    needsClarification: (parsed.missingInfo || []).length > 0,
  };

  onProgress("Generating report bundle...");
  generateReport(state, outDir);
  onProgress(`Done. Report: reports/${id}/index.html`);
  return state;
}

function buildMeta(pdfPath) {
  return {
    reviewDate: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    model: getModelName(),
    sourceFile: path.basename(pdfPath),
    toolVersion: "1.0.0",
  };
}
