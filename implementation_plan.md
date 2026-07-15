# Implementation Plan - Pre-Approval Website-Verification Tool

This plan details the design, architecture, and development stages for the Pre-Approval Website-Verification Tool. The tool assists human reviewers in auditing pre-approval forms by extracting data, researching provider websites, gathering screenshot evidence, and presenting a review-ready interactive report.

---

## Architecture Overview

We will build a local web-based application using:
- **Backend**: Node.js + Express
  - Playwright for browser navigation, element screenshots, and full-page captures (headless by default, with a headed/stealth fallback for bot-protected sites like Amazon).
  - `@google/genai` (Google Gen AI SDK) using `gemini-2.5-flash` for:
    1. Parsing the application PDF forms (using Gemini's native PDF understanding).
    2. Guiding the browser research agent (selecting which links to click, when evidence is found).
    3. Evaluating the checklist criteria based on webpage text.
    4. Managing interactive natural language commands (updating status, adding notes, re-running).
- **Frontend**: React + Vite (Vanilla CSS)
  - Interactive dashboard showing current files and previous reports.
  - Interactive Report Editor: lists extracted fields, rate comparisons, checklist status (Match/Pass, No Match/Fail, Needs Review), and inline evidence screenshots.
  - Chat Sidebar: allows plain-language commands to modify the report or re-run checks.
  - Exports a unified shareable report bundle.

---

## User Review Required

> [!IMPORTANT]
> **Gemini API Key Required**
> Running the tool requires a `GEMINI_API_KEY` with access to the `gemini-2.5-flash` or `gemini-1.5-pro` model. We will allow the user to provide this key in a `.env` file or dynamically through the application UI.

> [!TIP]
> **AI-Driven PDF Parsing**
> Traditional local PDF parsing (e.g. `pdf-parse`) struggles with scanned pages and layouts. We propose uploading the PDF directly to Gemini's API or passing it as inline data, letting Gemini's multimodal capabilities extract the text and structure. This ensures perfect extraction of scanned/handwritten forms.

---

## Proposed Changes

### Component 1: Configuration & Infrastructure

#### [NEW] [checklists.json](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/config/checklists.json)
Config-driven database of the checklists for all 7 form types (per Brief §5 — the "design implication" is that a non-engineer can add a new category by editing config only, no code changes):
- Specifies which checklist items are website-verifiable vs. **internal** (internal items are surfaced in the report as "Internal — not website-verifiable", never guessed).
- Defines specific evaluation criteria and LLM prompts for each website-verifiable item.
- Contains all program fee caps for the sanity-check:
  - Coaching: ≤ $55/group class, ≤ $111/private class, $500/year program cap.
  - HRI: $1,500/budget year, approval valid 3 months.
  - OTPS: $3,000/budget year.
  - Transition Program: ≤ $350/course, ≤ $800/month.
  - Community Classes invoice-rule context: >2 sessions/day (≤60 min each) or >7 sessions/week at one provider needs prior approval.
- Contains the exclusion lists: HRI (cell phone, computer, vehicle, medical device, pill dispenser…) and OTPS (cable TV, common household supplies, rental cars, legal fees, co-pays, experimental therapies…).
- Defines the **Appeal** category as: re-run the Community Classes website checks **framed against the extracted denial reason**, and instruct the evaluator to surface evidence that specifically supports or refutes that reason.

#### [NEW] [package.json](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/package.json)
Root package.json configuring workspace scripts to run client and server concurrently.

---

### Component 2: Backend (Express, Playwright & Gemini Client)

#### [NEW] [server.js](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/backend/server.js)
Express server handling API endpoints:
- `POST /api/upload`: Upload PDF application.
- `POST /api/parse`: Parse PDF using Gemini.
- `POST /api/verify`: Run Playwright research agent and evaluate checklist.
- `POST /api/chat`: Process natural language commands from the reviewer.
- `GET /api/reports`: List all generated report packages.
- Serves static assets, including generated reports and screenshot captures.

#### [NEW] [pdfParser.js](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/backend/pdfParser.js)
Extracts structured JSON fields from the PDF pre-approval forms.
- Uses Gemini API with structured outputs (JSON schema) to extract common fields: participant name, age, coordinator, broker, provider name, link to webpage, fee/rate/price, category, and the form's YES/NO checklist answers.
- Appeal forms additionally extract: **date of denial, reason for denial, and justification for appeal** (needed to frame the re-check).
- **Clarification behavior (Brief §7):** when key info is missing or ambiguous (no URL on the form, unclear provider/vendor, unclear requested item, ambiguous category), the parser flags it and the tool asks the reviewer instead of guessing.

#### [NEW] [researchAgent.js](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/backend/researchAgent.js)
The Playwright agent loop for researching provider websites:
- Spawns a browser, navigates to the target URL.
- Extracts text/links and takes viewport screenshots.
- Loops (max 5 pages) using Gemini to select the next action (click link, navigate, extract).
- Produces the **two kinds of evidence the Brief §6 mandates**:
  1. **Whole-page capture** — a full-page, top-to-bottom screenshot (or PDF) of the provider's homepage and/or the specific proof page (fees/schedule page). This is the "here is the website we reviewed" record.
  2. **Targeted evidence captures, one per confirmed requirement** — element-level screenshots (via `page.evaluate` highlighting + cropped capture) labeled with the requirement they support (e.g. "Evidence: published fees").
- **Date-stamping (hard requirement):** every capture gets a visible, burned-in banner showing the capture date/time and the exact URL captured (injected as a DOM overlay before screenshotting, or composited onto the image). Audit evidence without a visible timestamp + URL fails the spec.
- **Anti-bot fallback:** Samples 6–8 are Amazon product links, which aggressively block headless browsers. Strategy: run headed/stealth context with a realistic user agent; if the page is still blocked or a CAPTCHA appears, capture what was shown and mark affected items **Needs Review** — never fabricate. This graceful-degradation path also covers providers with no published fees, PDF flyers, or social-media pages.
- Saves files to `reports/<sample-id>/screenshots/`.

#### [NEW] [checklistEvaluator.js](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/backend/checklistEvaluator.js)
Takes the extracted website content and the requested form details, and runs Gemini evaluation prompts for each website-verifiable checklist item.
- Returns per-item status: `Match/Pass` / `No Match/Fail` / `Needs Review` / `Internal` (stored canonically as `Met`/`Not Met`/`Needs Review`; display wording lives in `backend/lib/labels.js`). Internal items pass through from config untouched — never evaluated or guessed.
- **Evidence-integrity guardrail:** every `Match/Pass` or `No Match/Fail` verdict must cite a verbatim quote from the actually-captured page text plus the evidence URL; the prompt instructs the model to return `Needs Review` when no direct quote exists. Quotes are programmatically checked to appear in the captured text before being accepted (anti-hallucination check).
- **Rate comparison:** compares the form's stated fee against the published fee and emits a plain-language verdict ("matches application exactly" / "differs" / "not published"), plus the fee-cap sanity check from config.
- **Appeal mode:** evaluates against the denial reason extracted from the form and explicitly states whether the website evidence supports or refutes it.

#### [NEW] [reportGenerator.js](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/backend/reportGenerator.js)
Saves the research state, builds `report.json`, and outputs a standalone, CSS-styled HTML report `index.html` inside `reports/<sample-id>/`. The report package (HTML + screenshots + report.json) is a self-contained shareable bundle and conveys everything Brief §6 requires:
- **Request at a glance** — participant name, provider/vendor, the specific item/class/membership, the URL, the category, and **the date the review was run**.
- **Rate comparison** — form rate vs. website rate with the plain-language verdict.
- **Per-criterion findings** — status, evidence URL, screenshot reference, and a plain-language note quoting the relevant line from the page.
- **Internal items** — listed in their own clearly-marked "Internal — not website-verifiable" section.
- **Evidence gallery** — whole-page and targeted captures, each showing its burned-in date/time + URL stamp.

---

### Component 3: Frontend (React & Vanilla CSS)

#### [NEW] [App.jsx](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/client/src/App.jsx)
Main SPA layout:
- **Dashboard View**: File upload widget, list of samples, previous reports history.
- **Reviewer View**:
  - Left panel: Extracted form details and pricing match comparison.
  - Middle panel: Interactive checklist. Displays "Match/Pass" (green), "No Match/Fail" (red), "Needs Review" (yellow), and "Internal" (gray). Clicking an item shows the specific evidence note and targeted screenshot.
  - Right panel: Interactive Chat Sidebar. Lets the reviewer type feedback (e.g. "Mark public schedule as Match/Pass because the schedule is on their homepage", "change fee to $50 and re-run").
- Styled using a premium dark-themed Vanilla CSS layout with glassmorphic panels and transitions.

---

### Component 4: Repo Deliverables & Documentation

These are graded deliverables per the README ("authoritative list") and Brief §9 — the tool alone is not a complete submission.

#### [UPDATE] [README.md](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/README.md)
Replace the challenge description with a project README containing:
- Run instructions simple enough for a **non-technical reviewer** (install, set `GEMINI_API_KEY`, one command to launch, one command to process a sample).
- Justification of the interface choice (web UI + chat) and the AI stack (why Gemini 2.5 Flash, why Playwright).
- A short note on **how to add or change a form/checklist** (edit `config/checklists.json` — no code changes).
- A statement of **limitations, assumptions, and what production-readiness would require** (incl. PHI handling: production would need to run under strict privacy controls; participant fields would be redacted/minimized before any third-party API call).

#### [COMMIT] Sample output report packages
At least 3 generated `reports/<sample-id>/` bundles (report + evidence captures) committed to the repo, as required by the challenge README.

#### [REPLACE] [AI-CONVERSATION.md](file:///c:/Users/achyu/Preapproval-verification-challenge-submission/AI-CONVERSATION.md)
Replace the placeholder with the exported real AI conversation (`/export` from Claude Code), with the tools & models list at the top. A submission with the placeholder intact is incomplete.

---

## Verification Plan

### Automated Tests
We will build a simple test harness to run the verification flow on multiple samples:
- `npm run test-samples` or `node backend/testRunner.js`
This script will run the full PDF extraction + website research + report generation on (minimum 3 required; this set covers the easy case, the exclusion trap, and the appeal):
1. `Sample-01---Community-Class-GallopNYC.pdf` (Community Class — should verify riding rate and public status; clearly-published evidence)
2. `Sample-07---HRI-Laptop---exclusion-test.pdf` (HRI — laptop/computer must be flagged as on the exclusion list; Amazon anti-bot path exercised)
3. `Sample-10---Appeal-Gracie-Barra-Jiu-Jitsu.pdf` (Appeal — re-runs Community Class checks framed against the denial reason "published fees could not be verified", exercising the appeal logic end-to-end)

If time permits, also run `Sample-02` (ambiguous/gated pricing) and `Sample-04` (Membership) for broader category coverage. The generated report packages for the runs above are committed to the repo (see Component 4).

### Manual Verification
- Launch the application via `npm run dev` and navigate to `http://localhost:5173`.
- Upload a sample PDF and verify the UI extracts fields correctly.
- Run the website verification and visually confirm the generated report layout and highlighted targeted screenshots.
- Test natural language editing by typing commands in the chat panel and verifying the UI and JSON report are updated correctly.
