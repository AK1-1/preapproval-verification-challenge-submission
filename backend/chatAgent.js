import path from "path";
import { Type } from "@google/genai";
import { generateJson } from "./lib/gemini.js";
import { generateReport, loadReport } from "./reportGenerator.js";
import { ROOT, SAMPLES_DIR, UPLOADS_DIR } from "./lib/config.js";
import fs from "fs";

const chatSchema = {
  type: Type.OBJECT,
  properties: {
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description: "set_status | add_note | add_finding_note | rerun | none",
          },
          findingId: { type: Type.STRING, description: "webCheck id for set_status / add_finding_note" },
          status: { type: Type.STRING, description: "Met | Not Met | Needs Review (for set_status)" },
          text: { type: Type.STRING, description: "note text (for add_note / add_finding_note), or reason" },
        },
        required: ["type"],
      },
    },
    reply: { type: Type.STRING, description: "Short plain-language reply to the reviewer describing what was done or answering their question." },
  },
  required: ["actions", "reply"],
};

/**
 * Plain-language reviewer commands (Brief §7): adjust statuses, add notes,
 * re-run the review, or answer questions about the report. Every manual
 * override is recorded in the report as a reviewer action (audit trail).
 */
export async function handleChat(reportDir, message, { startJob } = {}) {
  const state = loadReport(reportDir);

  const findingsDesc = state.findings
    .map((f) => `- id "${f.id}": [${f.status}] ${f.label} — ${f.note?.slice(0, 140)}`)
    .join("\n");

  const prompt = `You are the interactive assistant inside a pre-approval verification report. The human reviewer said:

"${message}"

CURRENT REPORT:
Participant: ${state.parsed.participantName}; requested: ${state.parsed.requestedItem}; provider: ${state.parsed.providerName}; stated fee: ${state.parsed.statedFee}.
Rate comparison verdict: ${state.rateComparison?.verdict} (form: ${state.rateComparison?.formRate}, website: ${state.rateComparison?.websiteRate}).
Findings:
${findingsDesc}

Translate the reviewer's request into actions:
- set_status: change a finding's status (findingId + status, and text = the reviewer's reason).
- add_finding_note: append a note to one finding (findingId + text).
- add_note: append a general reviewer note to the report (text).
- rerun: re-run the whole website verification for this application.
- none: the message is a question — just answer it in reply using only the report data above.

Rules: never invent evidence; if the reviewer asks something the report can't answer, say so. Status changes by the reviewer are allowed (they are the human in the loop) but must carry their reason.`;

  const result = await generateJson([{ text: prompt }], { schema: chatSchema });
  const applied = [];
  let rerunJobId = null;

  for (const action of result.actions || []) {
    if (action.type === "set_status" && action.findingId && action.status) {
      const f = state.findings.find((x) => x.id === action.findingId);
      if (f && ["Met", "Not Met", "Needs Review"].includes(action.status)) {
        const prev = f.status;
        f.status = action.status;
        f.note = `${f.note || ""} [Reviewer override ${new Date().toISOString().slice(0, 16)}: ${prev} -> ${action.status}${action.text ? ` — ${action.text}` : ""}]`.trim();
        f.reviewerOverride = true;
        applied.push(`set ${action.findingId}: ${prev} -> ${action.status}`);
      }
    } else if (action.type === "add_finding_note" && action.findingId && action.text) {
      const f = state.findings.find((x) => x.id === action.findingId);
      if (f) {
        f.note = `${f.note || ""} [Reviewer note: ${action.text}]`.trim();
        applied.push(`note on ${action.findingId}`);
      }
    } else if (action.type === "add_note" && action.text) {
      state.reviewerNotes = state.reviewerNotes || [];
      state.reviewerNotes.push({ text: action.text, addedAt: new Date().toISOString().slice(0, 16) });
      applied.push("added reviewer note");
    } else if (action.type === "rerun" && startJob) {
      const src = findSourcePdf(state.meta?.sourceFile);
      if (src) {
        rerunJobId = startJob(src);
        applied.push("re-run started");
      } else {
        applied.push("re-run failed: source PDF not found");
      }
    }
  }

  if (applied.length && !rerunJobId) {
    generateReport(state, reportDir);
  }

  return { reply: result.reply, applied, rerunJobId, state };
}

function findSourcePdf(sourceFile) {
  if (!sourceFile) return null;
  for (const dir of [SAMPLES_DIR, UPLOADS_DIR, ROOT]) {
    const p = path.join(dir, sourceFile);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
