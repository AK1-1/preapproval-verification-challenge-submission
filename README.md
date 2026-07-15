# Pre-Approval Website-Verification Tool

An AI tool that reads a completed OPWDD Self-Direction **pre-approval application (PDF)**, researches the provider's **public website**, captures **date-stamped screenshot evidence**, and produces a **review-ready report** for the Pre-Approvals team.

> The tool **assists** the reviewer — it never approves or denies anything. Honest "couldn't verify" results are correct and expected, and every finding is backed by a verbatim quote and a real screenshot.

Built for the F5 Global Talent AI Specialist build challenge. Original challenge brief: [`docs/Project-Brief.pdf`](docs/Project-Brief.pdf).

---

## How it works

```
application PDF ──► 1. PARSE (Gemini reads the form, even scans)
                        │  participant, provider, URL, fee, category, checklist answers
                        ▼
                    2. RESEARCH (Playwright browser, guided by Gemini)
                        │  visits up to 5 pages, saves full-page captures,
                        │  every capture stamped with date/time + URL
                        ▼
                    3. EVALUATE (Gemini judges each website-verifiable checklist item)
                        │  Met / Not Met require a verbatim quote — verified
                        │  programmatically against the captured text (no hallucinations)
                        ▼
                    4. TARGETED EVIDENCE (Playwright revisits, highlights the
                        │  proof on the page, saves a labeled focused screenshot)
                        ▼
                    5. REPORT  reports/<id>/  =  index.html + report.json + screenshots/
                              a self-contained, shareable audit bundle
```

Items a website **cannot** prove (budget approval, Life Plan goals, service duplication…) are listed separately as **"Internal — not website-verifiable"** and left for the human — the tool never guesses them.

## Quick start (non-technical friendly)

You need [Node.js 20+](https://nodejs.org) and a free Google Gemini API key from <https://aistudio.google.com/apikey>.

```bash
# 1. install everything (one time)
npm run setup

# 2. add your API key (one time)
#    copy .env.example to .env, open it, paste your key after GEMINI_API_KEY=

# 3. start the app
npm run dev
```

Then open **http://localhost:5173**, click **Verify** next to any sample application (or upload your own PDF), and watch the run log. When it finishes you get:

- an interactive report you can adjust by **typing plain English** in the chat sidebar
  (e.g. *"Change published fees to Needs Review because the schedule looks outdated"*, *"Add a note that the broker confirmed the rate"*, *"Re-run the verification"*), and
- a **shareable HTML report bundle** in `reports/<sample-id>/` you can zip and send — it opens in any browser with all evidence embedded by relative paths.

### Command-line instead

```bash
npm run verify                 # runs the 3 demonstration samples end-to-end
node backend/testRunner.js samples/Sample-04---Membership-Planet-Fitness.pdf   # any sample
```

## What a report contains

Per the project brief (§6):

- **The request at a glance** — participant, provider, item, URL, category, fee, review date.
- **Rate comparison** — form rate vs published rate, verdict: *matches application exactly / differs / not published*.
- **Per-criterion findings** — status (**Met / Not Met / Needs Review**), evidence URL, verbatim quote from the page, plain-language note, and a labeled targeted screenshot.
- **Internal items** — the form's questions the website can't answer, clearly marked, never guessed.
- **Evidence captures** — whole-page screenshots of every page reviewed **plus** one focused, labeled screenshot per confirmed finding. Every capture has a **burned-in banner with the capture date/time (UTC) and the URL** — the audit requirement.

Committed example bundles live in [`reports/`](reports/).

## Repo layout

```
backend/
  server.js             Express API (upload / verify / chat / reports)
  pipeline.js           orchestrates parse → research → evaluate → report
  pdfParser.js          Gemini PDF extraction (native PDF understanding, works on scans)
  researchAgent.js      Playwright agent: navigation, stamps, anti-bot fallback, targeted captures
  checklistEvaluator.js Gemini evaluation + verbatim-quote verification guardrail
  chatAgent.js          plain-language report editing (reviewer chat)
  reportGenerator.js    report.json + self-contained index.html
  testRunner.js         CLI runner
config/checklists.json  ALL checklist knowledge (categories, criteria, caps, exclusion lists)
client/                 React + Vite reviewer UI
samples/                the 10 provided sample applications
reports/                generated report bundles (committed examples included)
docs/                   the original challenge briefs
```

## Adding or changing a form / checklist

Everything category-specific lives in **`config/checklists.json`** — no code changes needed:

1. Add a new key under `categories` with a `label`, `detectHints` (phrases that identify the form), and a `webChecks` array. Each check has an `id`, a human `label`, and `criteria` — plain-English instructions for how to judge it from a webpage.
2. Optional: `caps` / `capNotes` (fee limits), `exclusionList` (items that must be flagged), and check `type` (`rate-comparison`, `cap-check`, `exclusion-check`, `needs-document`).
3. A category can `extends` another (the Appeal form reuses the Community Classes checks this way).

Any YES/NO question on a form that doesn't match a webCheck is automatically classified **Internal** — so new forms degrade safely.

## AI stack & why

| Choice | Why |
|---|---|
| **Gemini 2.5 Flash** (`@google/genai`) | Native multimodal PDF understanding handles scanned/imperfect forms without an OCR pipeline; structured JSON output; fast and cheap enough to run 4+ calls per application; free tier available for reviewers to test. |
| **Playwright** | Real Chromium rendering (many provider sites are JS-heavy), full-page screenshots, DOM access for burning stamps/highlights into the evidence, headed fallback for bot-protected sites. |
| **Web UI + chat** (over pure CLI) | The end users are non-technical reviewers; the brief (§7) requires plain-language interaction. A CLI runner is still included for scripted/CI use. |

### Anti-hallucination design (evidence integrity)

- A finding can only be **Met/Not Met** if the model returns a **verbatim quote**; the backend then checks that quote actually appears in the captured page text — if not, the finding is auto-downgraded to **Needs Review** and flagged.
- Screenshots are real captures of the live page, stamped at capture time. The tool never renders "evidence" itself.
- Bot-blocked or unreachable pages produce honest **Needs Review** results with the block noted in the report.

## Limitations & assumptions

- **Websites vary wildly.** Some providers don't publish fees; some (Amazon especially) block automation. The tool retries with a visible browser, and otherwise reports *Needs Review* — it does not scrape around blocks or fabricate.
- Research is capped at **5 pages per site** to keep runs fast and predictable; deep sites may need the reviewer to supply a more specific URL (the chat supports re-running).
- The evaluation quality is bounded by the captured **text** of pages; prices rendered only inside images may be missed (they still appear in the whole-page capture for the human).
- Checklist coverage matches the brief's §5 "website-verifiable subset"; internal items are intentionally not answered.
- One in-memory job at a time per server process; no auth — this is a local tool, not a deployed service.

### What production would require

- **PHI handling:** sample data here is synthetic. In production, participant fields (name, age, outcomes) would be redacted/minimized before any third-party API call, or the LLM would run in a HIPAA-eligible environment (e.g. Gemini on Vertex AI with a BAA); evidence bundles would live in access-controlled storage with retention policies.
- Queueing + persistence for jobs, user auth/roles, audit logging of reviewer overrides (partially present — overrides are recorded in the report), retry/monitoring, golden-set regression tests against the reviewer key, and legal review of site terms for automated access.

## The three committed demonstration runs

| Sample | Why it was chosen | Expected shape of result |
|---|---|---|
| 01 — GallopNYC community class | clearly-published evidence | fees/schedule found, rate compared |
| 07 — HRI laptop | **exclusion-list trap** | "Computer Hardware" → flagged Not Met |
| 10 — Appeal (Gracie Barra) | appeal workflow | checks re-run against the denial reason |
