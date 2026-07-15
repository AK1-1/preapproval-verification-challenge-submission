import fs from "fs";
import { Type } from "@google/genai";
import { generateJson } from "./lib/gemini.js";
import { categoryKeys } from "./lib/config.js";

const parseSchema = {
  type: Type.OBJECT,
  properties: {
    category: {
      type: Type.STRING,
      description: "One of the known category keys, or 'unknown'",
    },
    formTitle: { type: Type.STRING },
    participantName: { type: Type.STRING },
    participantAge: { type: Type.STRING },
    fiCoordinator: { type: Type.STRING },
    brokerName: { type: Type.STRING },
    requestedItem: {
      type: Type.STRING,
      description: "The class / item / membership / program / service requested",
    },
    providerName: { type: Type.STRING },
    url: { type: Type.STRING, description: "The link to webpage / item link on the form. Empty string if none." },
    statedFee: {
      type: Type.STRING,
      description: "The fee/rate/price exactly as written on the form, e.g. '$80 per 30-minute session'",
    },
    subjectArea: { type: Type.STRING },
    durationPerSession: { type: Type.STRING },
    safetyFeatures: { type: Type.STRING },
    justification: { type: Type.STRING },
    valuedOutcome: { type: Type.STRING },
    lpDate: { type: Type.STRING },
    appeal: {
      type: Type.OBJECT,
      nullable: true,
      description: "Only for Appeal forms",
      properties: {
        dateOfDenial: { type: Type.STRING },
        denialReason: { type: Type.STRING },
        appealJustification: { type: Type.STRING },
      },
    },
    checklistAnswers: {
      type: Type.ARRAY,
      description: "Every YES/NO question on the form with the answer that was ticked",
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          answer: { type: Type.STRING, description: "YES, NO, or BLANK" },
        },
        required: ["question", "answer"],
      },
    },
    missingInfo: {
      type: Type.ARRAY,
      description: "Key info that is missing or ambiguous (no URL, unclear provider, unclear item, ambiguous category). Empty if all clear.",
      items: { type: Type.STRING },
    },
  },
  required: ["category", "participantName", "requestedItem", "providerName", "url", "statedFee", "checklistAnswers", "missingInfo"],
};

/**
 * Parse a completed pre-approval application PDF into structured fields
 * using Gemini's native PDF understanding (works on scans too).
 */
export async function parseApplication(pdfPath) {
  const data = fs.readFileSync(pdfPath).toString("base64");
  const keys = categoryKeys();

  const prompt = `You are reading a completed OPWDD Self-Direction pre-approval application form (PDF, possibly scanned).

Extract the fields exactly as written on the form. Do not invent or normalize values - if a field is absent, return an empty string.

The category must be exactly one of: ${keys.join(", ")} - or "unknown" if genuinely ambiguous.
Category guide:
- "community-class": Community Class Pre-approval Checklist
- "coaching": Coaching pre-approval (for parents/spouse)
- "membership": Health club / organizational membership form
- "hri": Household Related Items form
- "otps": OTPS (Other Than Personal Services) form
- "transition-program": Transition Program form
- "appeal": Pre-Approval Appeals Form (has Date of Denial / Reason for the denial / Justification for Appeal)

For the checklistAnswers, list EVERY yes/no question in the checklist table with the ticked answer (YES / NO / BLANK).
For an appeal form, fill the "appeal" object with the denial date, the reason for the denial, and the appeal justification.
In missingInfo, report ONLY things that would block a website review: no URL, unreadable/ambiguous provider or item, unclear category. Do NOT report a missing fee as blocking — some forms (HRI/OTPS) have no fee field because the price is read from the product page.`;

  const parsed = await generateJson(
    [
      { inlineData: { mimeType: "application/pdf", data } },
      { text: prompt },
    ],
    { schema: parseSchema }
  );

  // Defensive normalization
  parsed.url = (parsed.url || "").trim();
  if (parsed.url && !/^https?:\/\//i.test(parsed.url)) {
    parsed.url = "https://" + parsed.url;
  }
  if (!keys.includes(parsed.category)) parsed.category = "unknown";
  parsed.missingInfo = parsed.missingInfo || [];
  if (!parsed.url) parsed.missingInfo.push("No website URL found on the form - reviewer must supply one.");
  if (parsed.category === "unknown") parsed.missingInfo.push("Form category is ambiguous - reviewer must pick the checklist.");
  return parsed;
}
