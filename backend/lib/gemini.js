import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let client = null;

export function getModelName() {
  return MODEL;
}

export function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key (https://aistudio.google.com/apikey)."
      );
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/**
 * Call Gemini and get a JSON object back.
 * `parts` is an array of content parts (text and/or inlineData).
 * Retries once on transient failure or unparseable JSON.
 */
export async function generateJson(parts, { schema, temperature = 0 } = {}) {
  const ai = getClient();
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts }],
        config: {
          temperature,
          responseMimeType: "application/json",
          ...(schema ? { responseSchema: schema } : {}),
        },
      });
      const text = res.text;
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

export async function generateText(parts, { temperature = 0.2 } = {}) {
  const ai = getClient();
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: { temperature },
  });
  return res.text;
}
