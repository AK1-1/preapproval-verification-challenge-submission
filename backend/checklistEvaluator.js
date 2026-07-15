import { Type } from "@google/genai";
import { generateJson } from "./lib/gemini.js";

const VALID_STATUSES = ["Met", "Not Met", "Needs Review"];

const evalSchema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "The webCheck id" },
          status: { type: Type.STRING, description: "Met | Not Met | Needs Review" },
          evidenceUrl: { type: Type.STRING, description: "URL of the visited page carrying the evidence. Empty if none." },
          quote: {
            type: Type.STRING,
            description: "VERBATIM text copied character-for-character from the provided page text that proves the status. Empty if no direct quote exists.",
          },
          note: { type: Type.STRING, description: "Plain-language explanation of what the page shows" },
        },
        required: ["id", "status", "note"],
      },
    },
    rateComparison: {
      type: Type.OBJECT,
      properties: {
        formRate: { type: Type.STRING },
        websiteRate: { type: Type.STRING, description: "The rate found on the website, or 'not published'" },
        verdict: { type: Type.STRING, description: "one of: matches application exactly | differs | not published" },
        note: { type: Type.STRING },
      },
      required: ["formRate", "websiteRate", "verdict", "note"],
    },
    appealAssessment: {
      type: Type.STRING,
      description: "Appeals only: does the website evidence SUPPORT or REFUTE the stated denial reason, and why. Empty otherwise.",
    },
  },
  required: ["findings", "rateComparison"],
};

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Evaluate every website-verifiable checklist item against the captured page
 * text. Every Met / Not Met verdict must carry a verbatim quote that we then
 * verify actually appears in the captured text — if it doesn't, the finding
 * is downgraded to Needs Review (anti-hallucination guardrail).
 */
export async function evaluateChecklist(parsed, category, pages) {
  const usablePages = pages.filter((p) => p.text && !p.error);
  const pagesBlob = usablePages
    .map((p, i) => `=== PAGE ${i + 1}: ${p.url} ("${p.title}") captured ${p.capturedAt} ===\n${p.text}`)
    .join("\n\n");

  const checksDesc = category.webChecks
    .map((c) => `- id "${c.id}" — ${c.label}\n  How to judge: ${c.criteria}`)
    .join("\n");

  const exclusionBlock = category.exclusionList
    ? `\nEXCLUSION LIST for this category:\n${category.exclusionList.map((e) => `- ${e}`).join("\n")}\n`
    : "";
  const capsBlock = category.capNotes?.length
    ? `\nPROGRAM CAP RULES:\n${category.capNotes.map((c) => `- ${c}`).join("\n")}\n`
    : "";

  const appealBlock = category.appeal
    ? `\nTHIS IS AN APPEAL. Denial date: ${parsed.appeal?.dateOfDenial || "?"}. Stated denial reason: "${parsed.appeal?.denialReason || "?"}". Appellant justification: "${parsed.appeal?.appealJustification || "?"}".\n${category.appealInstructions}\nFill appealAssessment accordingly.\n`
    : "";

  const prompt = `You are the evaluation engine of a pre-approval website-verification tool used by a government-audited human-services agency. Your findings must hold up in an audit.

THE REQUEST (from the application form):
- Requested: ${parsed.requestedItem}
- Provider/vendor: ${parsed.providerName}
- Stated fee on form: ${parsed.statedFee}
- Participant age: ${parsed.participantAge}
- Category: ${category.label}
${appealBlock}${capsBlock}${exclusionBlock}
CHECKS TO EVALUATE (return EXACTLY one finding for every id below, in order — never omit or merge them, even when another section covers similar ground):
${checksDesc}

CAPTURED WEBSITE TEXT (the ONLY evidence you may use):
${pagesBlob || "(no pages could be captured)"}

STRICT RULES — violating them corrupts an audit file:
1. Use ONLY the captured page text above. Never use outside knowledge about the provider or product.
2. "Met" or "Not Met" REQUIRES a verbatim quote copied exactly from the page text, plus the page URL. No quote available = "Needs Review".
3. If pages are missing, blocked, or the text is silent on a check, the status is "Needs Review" and the note says what could not be verified and why. An honest "couldn't verify" is a correct answer.
4. Checks of type cap-check compare numbers found in the form/page text against the cap rules; quote the price you used.
5. EXCEPTION — checks of type exclusion-check judge the item REQUESTED ON THE FORM ("${parsed.requestedItem}") against the exclusion list. This judgment does not need webpage evidence: if the requested item plainly belongs to an excluded category, mark it "Not Met" even when the website is blocked or silent, and say in the note which exclusion-list entry it matches. Set quote to the page text identifying the item if available, otherwise leave the quote empty.
6. For the rateComparison, compare "${parsed.statedFee}" with what the site publishes; verdict must be exactly one of: matches application exactly | differs | not published.`;

  const result = await generateJson([{ text: prompt }], { schema: evalSchema });

  // ---- Post-processing guardrails ----
  const allText = normalize(usablePages.map((p) => p.text).join(" "));
  const byId = new Map((result.findings || []).map((f) => [f.id, f]));
  const findings = [];

  for (const check of category.webChecks) {
    let f = byId.get(check.id);
    // If the model omitted a rate-comparison finding, derive it
    // deterministically from its own rateComparison verdict instead of
    // producing a contradictory "Needs Review".
    if (!f && check.type === "rate-comparison" && result.rateComparison?.verdict) {
      const v = result.rateComparison.verdict;
      f = {
        id: check.id,
        status: v === "matches application exactly" ? "Met" : v === "differs" ? "Not Met" : "Needs Review",
        note: `${result.rateComparison.note} (Derived from the rate comparison: form "${result.rateComparison.formRate}" vs website "${result.rateComparison.websiteRate}" — ${v}.)`,
        quote: "",
        derivedFromRateComparison: true,
      };
    }
    f = f || {
      id: check.id,
      status: "Needs Review",
      note: "The evaluator returned no finding for this item.",
    };
    f.label = check.label;
    f.type = check.type || "web-check";

    if (!VALID_STATUSES.includes(f.status)) f.status = "Needs Review";

    // needs-document items can never be proven by a website
    if (check.type === "needs-document") {
      f.status = "Needs Review";
      f.note = check.criteria.includes("needs document")
        ? f.note || ""
        : f.note;
      f.needsDocument = true;
      if (!/needs document/i.test(f.note || "")) {
        f.note = `Needs document: this item is proven by a provider letter, not the website. ${f.note || ""}`.trim();
      }
      f.quote = "";
    }

    // Anti-hallucination: verify the quote really appears in captured text.
    // Exclusion checks are judged from the form's own item name, and findings
    // derived from the rate comparison carry its rates instead of a quote, so
    // both are exempt from the webpage-quote requirement.
    if ((f.status === "Met" || f.status === "Not Met") && f.type !== "needs-document" && f.type !== "exclusion-check" && !f.derivedFromRateComparison) {
      const q = normalize(f.quote);
      if (!q || q.length < 3 || !allText.includes(q)) {
        f.originalStatus = f.status;
        f.status = "Needs Review";
        f.quoteVerified = false;
        f.note = `${f.note} [Auto-downgraded to Needs Review: the supporting quote could not be verified verbatim in the captured page text.]`;
        f.quote = f.quote || "";
      } else {
        f.quoteVerified = true;
      }
    }
    findings.push(f);
  }

  // Classify the form's own YES/NO questions: covered by a webCheck vs internal.
  const internalItems = classifyInternal(parsed, category);

  return {
    findings,
    rateComparison: result.rateComparison,
    appealAssessment: result.appealAssessment || "",
    internalItems,
  };
}

/**
 * Any form question not clearly corresponding to a website check is Internal —
 * the tool must list it, unanswered, for the human reviewer (Brief §5).
 */
function classifyInternal(parsed, category) {
  const checkWords = category.webChecks.map((c) => normalize(c.label));
  return (parsed.checklistAnswers || []).map((qa) => {
    const q = normalize(qa.question);
    const covered = checkWords.some((label) => overlapScore(q, label) >= 0.6);
    return { question: qa.question, formAnswer: qa.answer, websiteVerifiable: covered };
  });
}

function overlapScore(a, b) {
  const stop = new Set(["the", "a", "an", "is", "are", "of", "for", "and", "or", "to", "in", "by", "does", "do", "not", "no", "class", "item", "with"]);
  const ta = new Set(a.split(" ").filter((w) => w.length > 2 && !stop.has(w)));
  const tb = [...new Set(b.split(" ").filter((w) => w.length > 2 && !stop.has(w)))];
  if (!tb.length) return 0;
  const hits = tb.filter((w) => ta.has(w)).length;
  return hits / tb.length;
}
