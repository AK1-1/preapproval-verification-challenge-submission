import fs from "fs";
import path from "path";

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STATUS_COLORS = {
  Met: "#2a9d8f",
  "Not Met": "#e63946",
  "Needs Review": "#e9a820",
  Internal: "#8d99ae",
};

function badge(status) {
  const c = STATUS_COLORS[status] || "#8d99ae";
  return `<span class="badge" style="background:${c}">${esc(status)}</span>`;
}

/**
 * Writes report.json and a fully self-contained index.html into outDir.
 * The HTML references only the local screenshots/ folder, so the whole
 * reports/<id>/ directory is a shareable audit bundle.
 */
export function generateReport(state, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(outDir, "index.html"), renderHtml(state));
}

export function loadReport(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf-8"));
}

export function renderHtml(state) {
  const { parsed, category, findings, rateComparison, internalItems, pages, meta, appealAssessment, reviewerNotes } = state;

  const clarifications = (parsed.missingInfo || []).length
    ? `<div class="card warn"><h2>⚠ Clarification needed</h2><ul>${parsed.missingInfo
        .map((m) => `<li>${esc(m)}</li>`)
        .join("")}</ul></div>`
    : "";

  const appealBlock = parsed.appeal?.denialReason
    ? `<div class="card appeal"><h2>Appeal context</h2>
       <p><strong>Date of denial:</strong> ${esc(parsed.appeal.dateOfDenial)}</p>
       <p><strong>Stated denial reason:</strong> ${esc(parsed.appeal.denialReason)}</p>
       <p><strong>Appellant justification:</strong> ${esc(parsed.appeal.appealJustification)}</p>
       ${appealAssessment ? `<p class="assessment"><strong>Website-evidence assessment:</strong> ${esc(appealAssessment)}</p>` : ""}
       </div>`
    : "";

  const verdictColor =
    rateComparison?.verdict === "matches application exactly"
      ? STATUS_COLORS.Met
      : rateComparison?.verdict === "differs"
        ? STATUS_COLORS["Not Met"]
        : STATUS_COLORS["Needs Review"];

  const findingRows = (findings || [])
    .map((f) => {
      const shot = f.targetedScreenshot
        ? `<a href="${esc(f.targetedScreenshot)}" target="_blank"><img class="thumb" src="${esc(f.targetedScreenshot)}" alt="Evidence for ${esc(f.label)}"></a>`
        : `<span class="muted">no targeted capture</span>`;
      return `<tr>
        <td>${badge(f.status)}${f.quoteVerified === false ? '<div class="muted small">quote unverified</div>' : ""}</td>
        <td><strong>${esc(f.label)}</strong>
          <div class="note">${esc(f.note)}</div>
          ${f.quote ? `<blockquote>“${esc(f.quote)}”</blockquote>` : ""}
          ${f.evidenceUrl ? `<div class="small">Source: <a href="${esc(f.evidenceUrl)}" target="_blank">${esc(f.evidenceUrl)}</a></div>` : ""}
          ${f.targetedCapturedAt ? `<div class="small muted">Capture: ${esc(f.targetedCapturedAt)}</div>` : ""}
          ${f.targetedNote ? `<div class="small muted">${esc(f.targetedNote)}</div>` : ""}
        </td>
        <td class="shotcell">${shot}</td>
      </tr>`;
    })
    .join("");

  const internalRows = (internalItems || [])
    .filter((i) => !i.websiteVerifiable)
    .map(
      (i) => `<tr><td>${badge("Internal")}</td><td>${esc(i.question)}</td><td>${esc(i.formAnswer)}</td></tr>`
    )
    .join("");

  const notesBlock = (reviewerNotes || []).length
    ? `<div class="card"><h2>Reviewer notes</h2><ul>${reviewerNotes
        .map((n) => `<li>${esc(n.text)} <span class="muted small">(${esc(n.addedAt)})</span></li>`)
        .join("")}</ul></div>`
    : "";

  const gallery = (pages || [])
    .filter((p) => p.screenshot)
    .map(
      (p) => `<figure>
        <a href="${esc(p.screenshot)}" target="_blank"><img src="${esc(p.screenshot)}" alt="Full-page capture of ${esc(p.url)}"></a>
        <figcaption><a href="${esc(p.url)}" target="_blank">${esc(p.url)}</a><br>
        <span class="muted">Captured ${esc(p.capturedAt)}${p.blocked ? " — ⚠ page appeared bot-blocked" : ""}</span></figcaption>
      </figure>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pre-Approval Verification — ${esc(parsed.participantName)} — ${esc(parsed.requestedItem)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 "Segoe UI", system-ui, sans-serif; color: #212529; background: #f4f5f7; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  header.main { background: #1d3557; color: #fff; padding: 28px 32px; border-radius: 10px 10px 0 0; }
  header.main h1 { margin: 0 0 6px; font-size: 22px; }
  header.main .sub { color: #a8dadc; font-size: 13px; }
  .card { background: #fff; border: 1px solid #e0e3e8; border-radius: 8px; padding: 20px 24px; margin-top: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 16px; color: #1d3557; text-transform: uppercase; letter-spacing: .04em; }
  .card.warn { border-left: 5px solid #e9a820; }
  .card.appeal { border-left: 5px solid #457b9d; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-top: 1px solid #eceef1; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; color: #6c757d; border-top: none; }
  .kv td:first-child { width: 220px; color: #6c757d; }
  .badge { display: inline-block; color: #fff; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .note { margin-top: 4px; }
  blockquote { margin: 8px 0 4px; padding: 6px 12px; border-left: 3px solid #a8dadc; background: #f1f8f9; font-style: italic; }
  .small { font-size: 12px; }
  .muted { color: #8d99ae; }
  .thumb { max-width: 220px; max-height: 160px; border: 1px solid #dee2e6; border-radius: 4px; }
  .shotcell { width: 240px; }
  .verdict { display: inline-block; color: #fff; font-weight: 700; padding: 6px 14px; border-radius: 6px; }
  figure { margin: 16px 0; }
  figure img { max-width: 100%; border: 1px solid #dee2e6; border-radius: 6px; max-height: 480px; object-fit: contain; object-position: top; }
  figcaption { font-size: 13px; margin-top: 6px; word-break: break-all; }
  footer { margin-top: 24px; font-size: 12px; color: #6c757d; text-align: center; }
  .tablewrap { overflow-x: auto; }
  @media print { body { background: #fff; } .card { border: none; padding: 8px 0; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="main">
    <h1>Pre-Approval Website-Verification Report</h1>
    <div class="sub">${esc(category.label)} · Review run ${esc(meta.reviewDate)} · Generated by the Pre-Approval Verification Tool (assists the reviewer — final approve/deny decision is made by staff)</div>
  </header>

  <div class="card">
    <h2>The request at a glance</h2>
    <table class="kv">
      <tr><td>Participant</td><td>${esc(parsed.participantName)} (age ${esc(parsed.participantAge)})</td></tr>
      <tr><td>Provider / vendor</td><td>${esc(parsed.providerName)}</td></tr>
      <tr><td>Requested</td><td>${esc(parsed.requestedItem)}${parsed.subjectArea ? ` — ${esc(parsed.subjectArea)}` : ""}</td></tr>
      <tr><td>Website reviewed</td><td><a href="${esc(parsed.url)}" target="_blank">${esc(parsed.url)}</a></td></tr>
      <tr><td>Category / checklist</td><td>${esc(category.label)}</td></tr>
      <tr><td>Fee stated on form</td><td>${esc(parsed.statedFee)}</td></tr>
      <tr><td>Review date</td><td>${esc(meta.reviewDate)}</td></tr>
      <tr><td>FI coordinator / broker</td><td>${esc(parsed.fiCoordinator)} / ${esc(parsed.brokerName)}</td></tr>
    </table>
  </div>

  ${clarifications}
  ${appealBlock}

  <div class="card">
    <h2>Rate comparison</h2>
    <table class="kv">
      <tr><td>Rate on application</td><td>${esc(rateComparison?.formRate)}</td></tr>
      <tr><td>Rate found on website</td><td>${esc(rateComparison?.websiteRate)}</td></tr>
      <tr><td>Verdict</td><td><span class="verdict" style="background:${verdictColor}">${esc(rateComparison?.verdict)}</span></td></tr>
      <tr><td>Note</td><td>${esc(rateComparison?.note)}</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>Website-verifiable checklist findings</h2>
    <div class="tablewrap">
    <table>
      <tr><th>Status</th><th>Finding</th><th>Targeted evidence</th></tr>
      ${findingRows}
    </table>
    </div>
  </div>

  <div class="card">
    <h2>Internal items — not website-verifiable (left for the human reviewer)</h2>
    <p class="small muted">These questions depend on internal data (budget, Life Plan, other funded services). The tool does not guess them; the answers shown are what was ticked on the form.</p>
    <div class="tablewrap">
    <table>
      <tr><th>Status</th><th>Form question</th><th>Answer on form</th></tr>
      ${internalRows || '<tr><td colspan="3" class="muted">None</td></tr>'}
    </table>
    </div>
  </div>

  ${notesBlock}

  <div class="card">
    <h2>Evidence — whole-page captures</h2>
    <p class="small muted">Each capture carries a burned-in banner with the capture date/time (UTC) and the URL, as required for the audit file.</p>
    ${gallery || '<p class="muted">No captures could be taken.</p>'}
  </div>

  <footer>
    Generated ${esc(meta.reviewDate)} · Model: ${esc(meta.model)} · Source form: ${esc(meta.sourceFile)}<br>
    This tool assists the Pre-Approvals reviewer. It never approves or denies; honest “couldn’t verify” results are expected.
  </footer>
</div>
</body>
</html>`;
}
