import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { Type } from "@google/genai";
import { generateJson } from "./lib/gemini.js";

const MAX_PAGES = 5;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BLOCK_PATTERNS =
  /robot check|captcha|access denied|automated access|verify you are a human|pardon our interruption|are you a robot|unusual traffic/i;

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function newBrowser(headless) {
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  return { browser, context };
}

async function dismissCookieBanners(page) {
  const selectors = [
    "#sp-cc-accept", // Amazon
    "button#onetrust-accept-btn-handler",
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('Accept Cookies')",
    "button:has-text('I Accept')",
    "button:has-text('Got it')",
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 700 })) {
        await el.click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      /* banner not present - fine */
    }
  }
}

/**
 * Scroll through the page to force lazy-loaded content, then return to top.
 * Without this, layouts shift after measurement and evidence clips/screenshots
 * land on the wrong region.
 */
async function settlePage(page) {
  try {
    await page.evaluate(async () => {
      const step = window.innerHeight;
      const max = document.documentElement.scrollHeight;
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);
  } catch {
    /* non-fatal */
  }
}

async function isBlocked(page) {
  try {
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (BLOCK_PATTERNS.test(title) || BLOCK_PATTERNS.test(bodyText.slice(0, 3000))) return true;
    return bodyText.trim().length < 150;
  } catch {
    return true;
  }
}

/**
 * Inject a visible date/URL stamp banner at the top of the document,
 * in normal flow so it appears exactly once in full-page captures.
 * Audit requirement: every capture must show when and what URL was captured.
 */
async function injectStamp(page, url, { fixed = false } = {}) {
  const text = `EVIDENCE CAPTURE — ${nowStamp()} — ${url} — Pre-Approval Verification Tool`;
  await page.evaluate(({ t, fixed }) => {
    const old = document.getElementById("__pav_stamp");
    if (old) old.remove();
    const div = document.createElement("div");
    div.id = "__pav_stamp";
    div.textContent = t;
    // In-flow (prepended) for full-page captures so it appears exactly once at
    // the top; position:fixed for viewport captures so no site header can
    // cover it.
    const pos = fixed
      ? "position:fixed;top:0;left:0;right:0;"
      : "position:relative;";
    div.style.cssText =
      pos +
      "z-index:2147483647;background:#1a1a2e;color:#ffd166;" +
      "font:600 13px/1.6 monospace;padding:8px 14px;border-bottom:3px solid #ffd166;" +
      "word-break:break-all;";
    document.body.prepend(div);
  }, { t: text, fixed });
}

async function removeStamp(page) {
  await page.evaluate(() => document.getElementById("__pav_stamp")?.remove()).catch(() => {});
}

async function extractPageData(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const label = (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 80);
      if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
      if (seen.has(href) || !label) continue;
      seen.add(href);
      links.push({ label, href });
      if (links.length >= 60) break;
    }
    return { title: document.title, text: text.slice(0, 15000), links };
  });
}

const navSchema = {
  type: Type.OBJECT,
  properties: {
    enoughEvidence: {
      type: Type.BOOLEAN,
      description: "true if the pages visited so far plausibly cover all the checks that CAN be answered on this site",
    },
    stillMissing: { type: Type.ARRAY, items: { type: Type.STRING } },
    nextUrls: {
      type: Type.ARRAY,
      description: "Up to 2 URLs from the provided link list most likely to contain the missing evidence (fees, schedule, membership, program pages). Empty if enoughEvidence or nothing promising.",
      items: { type: Type.STRING },
    },
    reason: { type: Type.STRING },
  },
  required: ["enoughEvidence", "nextUrls", "reason"],
};

async function decideNext(parsed, category, visitedPages, currentPage) {
  const checksDesc = category.webChecks
    .map((c) => `- [${c.id}] ${c.label}`)
    .join("\n");
  const prompt = `You are guiding a website research agent verifying a pre-approval application.

REQUEST: "${parsed.requestedItem}" from provider "${parsed.providerName}" — stated fee: "${parsed.statedFee}".
CHECKS THAT NEED WEBSITE EVIDENCE:
${checksDesc}

PAGES ALREADY VISITED:
${visitedPages.map((p) => `- ${p.url} ("${p.title}")`).join("\n")}

CURRENT PAGE (${currentPage.url}) TEXT (truncated):
---
${currentPage.text.slice(0, 9000)}
---

LINKS AVAILABLE ON CURRENT PAGE:
${currentPage.links.map((l) => `- "${l.label}" -> ${l.href}`).join("\n").slice(0, 6000)}

Decide whether the visited pages already contain the evidence needed (prices, schedules, public availability, program descriptions), or which of the available links to visit next. Prefer pricing/fees/schedule/membership/program pages on the SAME site. Never pick login, cart, social-media, or unrelated pages. At most ${MAX_PAGES} pages total will be visited.`;

  return generateJson([{ text: prompt }], { schema: navSchema });
}

/**
 * Phase 1 — research: navigate from the form's URL, let Gemini choose up to
 * MAX_PAGES pages, and save a date-stamped full-page capture of each.
 * Returns { pages, blocked, headed }.
 */
export async function runResearch(parsed, category, outDir, onProgress = () => {}) {
  const screenshotsDir = path.join(outDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  let headless = process.env.HEADED === "1" ? false : true;
  let attempt = await researchSession(parsed, category, screenshotsDir, headless, onProgress);

  // Anti-bot fallback: if the very first page was blocked in headless mode,
  // retry once with a headed browser (helps with Amazon and similar).
  if (attempt.blocked && headless) {
    onProgress("First page looked bot-blocked in headless mode — retrying with a visible browser...");
    try {
      const retry = await researchSession(parsed, category, screenshotsDir, false, onProgress);
      if (!retry.blocked) return { ...retry, headed: true };
      // keep whichever attempt captured more pages
      return retry.pages.length >= attempt.pages.length ? { ...retry, headed: true } : attempt;
    } catch {
      return attempt;
    }
  }
  return attempt;
}

async function researchSession(parsed, category, screenshotsDir, headless, onProgress) {
  const { browser, context } = await newBrowser(headless);
  const pages = [];
  let blocked = false;
  try {
    const page = await context.newPage();
    const queue = [parsed.url];
    const visited = new Set();

    while (queue.length && pages.length < MAX_PAGES) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);
      onProgress(`Visiting ${url} (${pages.length + 1}/${MAX_PAGES})`);

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2500);
        await dismissCookieBanners(page);
        await settlePage(page);
      } catch (err) {
        onProgress(`Could not load ${url}: ${err.message}`);
        pages.push({ url, title: "(failed to load)", text: "", links: [], error: err.message, capturedAt: null, screenshot: null, blocked: false });
        continue;
      }

      const pageBlocked = await isBlocked(page);
      if (pageBlocked && pages.length === 0) blocked = true;

      const data = await extractPageData(page);
      const fileBase = `page-${pages.length + 1}`;
      const shotPath = path.join(screenshotsDir, `${fileBase}-fullpage.png`);
      const capturedAt = new Date().toISOString();
      const finalUrl = page.url();

      try {
        await injectStamp(page, finalUrl);
        await page.screenshot({ path: shotPath, fullPage: true });
        await removeStamp(page);
      } catch {
        // Full-page capture can fail on very tall pages; fall back to viewport.
        await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
        await removeStamp(page);
      }

      pages.push({
        url: finalUrl,
        title: data.title,
        text: data.text,
        links: data.links,
        screenshot: `screenshots/${fileBase}-fullpage.png`,
        capturedAt,
        blocked: pageBlocked,
      });

      if (pageBlocked) {
        onProgress(`Page appears bot-blocked: ${finalUrl}`);
        continue;
      }

      if (pages.length >= MAX_PAGES) break;

      try {
        const decision = await decideNext(parsed, category, pages, pages[pages.length - 1]);
        onProgress(`Navigator: ${decision.reason}`);
        if (decision.enoughEvidence) break;
        for (const next of (decision.nextUrls || []).slice(0, 2)) {
          if (!visited.has(next)) queue.push(next);
        }
        if (!queue.length) break;
      } catch (err) {
        onProgress(`Navigation decision failed (${err.message}) — stopping research.`);
        break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { pages, blocked, headed: !headless };
}

/**
 * Phase 2 — targeted evidence captures: for each confirmed finding, revisit
 * the evidence URL, locate the quoted text, highlight it, and save a labeled,
 * date-stamped focused screenshot (Brief §6, evidence kind 2).
 */
export async function captureTargetedEvidence(findings, outDir, onProgress = () => {}, headed = false, visitedUrls = []) {
  const screenshotsDir = path.join(outDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const toCapture = findings.filter(
    (f) => f.quote && f.evidenceUrl && (f.status === "Met" || f.status === "Not Met")
  );
  if (!toCapture.length) return;

  // LLMs occasionally mangle long URLs (case typos etc.) — snap each evidence
  // URL to the exact URL the agent actually visited.
  for (const f of toCapture) {
    const match = visitedUrls.find((u) => u.toLowerCase() === f.evidenceUrl.toLowerCase());
    if (match) f.evidenceUrl = match;
  }

  const { browser, context } = await newBrowser(!headed && process.env.HEADED !== "1");
  try {
    const page = await context.newPage();
    // Group by URL so each page loads once.
    const byUrl = new Map();
    for (const f of toCapture) {
      if (!byUrl.has(f.evidenceUrl)) byUrl.set(f.evidenceUrl, []);
      byUrl.get(f.evidenceUrl).push(f);
    }

    for (const [url, items] of byUrl) {
      onProgress(`Capturing targeted evidence on ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000);
        await dismissCookieBanners(page);
        await settlePage(page);
      } catch (err) {
        onProgress(`Could not reload ${url} for targeted capture: ${err.message}`);
        continue;
      }

      for (const f of items) {
        const capturedAt = new Date().toISOString();
        const label = `EVIDENCE: ${f.label}`;
        const stampText = `${label} — captured ${nowStamp()} — ${url}`;
        const needle = f.quote.replace(/\s+/g, " ").trim().slice(0, 80);

        const rect = await page.evaluate(
          async ({ needle, stampText }) => {
            document.getElementById("__pav_hl")?.remove();
            document.getElementById("__pav_hl_label")?.remove();
            const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
            const target = norm(needle);
            // Quotes routinely span multiple DOM nodes ("Group Classes" +
            // "30-Min Group - $80"), so match on element innerText and pick
            // the DEEPEST (shortest-text) element that contains the quote.
            let found = null;
            let foundLen = Infinity;
            for (const el of document.body.querySelectorAll("*")) {
              if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME"].includes(el.tagName)) continue;
              const txt = el.innerText;
              if (!txt || txt.length >= foundLen) continue;
              if (norm(txt).includes(target)) {
                found = el;
                foundLen = txt.length;
              }
            }
            if (!found) return null;
            found.scrollIntoView({ block: "center" });
            // Let lazy images/fonts settle, then re-measure — positions taken
            // before the settle can be stale and the capture lands elsewhere.
            await new Promise((r) => setTimeout(r, 800));
            found.scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 200));
            const r = found.getBoundingClientRect();
            if (!r.width && !r.height) return null;
            const abs = {
              x: r.x + window.scrollX,
              y: r.y + window.scrollY,
              width: r.width,
              height: r.height,
            };
            const hl = document.createElement("div");
            hl.id = "__pav_hl";
            hl.style.cssText =
              `position:absolute;left:${abs.x - 6}px;top:${abs.y - 6}px;width:${abs.width + 12}px;` +
              `height:${abs.height + 12}px;border:4px solid #e63946;border-radius:4px;` +
              "z-index:2147483646;pointer-events:none;box-shadow:0 0 0 4000px rgba(0,0,0,0.06);";
            document.body.appendChild(hl);
            const lbl = document.createElement("div");
            lbl.id = "__pav_hl_label";
            lbl.textContent = stampText;
            lbl.style.cssText =
              `position:absolute;left:${Math.max(8, abs.x - 6)}px;top:${Math.max(8, abs.y - 44)}px;` +
              "background:#e63946;color:#fff;font:600 12px/1.5 monospace;padding:5px 10px;" +
              "z-index:2147483647;pointer-events:none;max-width:900px;word-break:break-all;border-radius:3px;";
            document.body.appendChild(lbl);
            return abs;
          },
          { needle, stampText }
        );

        const shotName = `evidence-${f.id}.png`;
        const shotPath = path.join(screenshotsDir, shotName);

        if (rect) {
          // The quote element is scrolled to the viewport center with the
          // highlight + label overlays drawn; a plain viewport screenshot is
          // always valid and keeps the surrounding context.
          try {
            await page.screenshot({ path: shotPath, fullPage: false });
            f.targetedScreenshot = `screenshots/${shotName}`;
            f.targetedCapturedAt = capturedAt;
          } catch (err) {
            onProgress(`Targeted capture failed for ${f.id}: ${err.message}`);
          }
          await page.evaluate(() => {
            document.getElementById("__pav_hl")?.remove();
            document.getElementById("__pav_hl_label")?.remove();
          });
        }

        if (!f.targetedScreenshot) {
          // Quote not locatable (dynamic content etc.) — fall back to a
          // stamped viewport capture so the finding still has real evidence.
          await injectStamp(page, url, { fixed: true });
          try {
            await page.screenshot({ path: shotPath, fullPage: false });
            f.targetedScreenshot = `screenshots/${shotName}`;
            f.targetedCapturedAt = capturedAt;
            f.targetedNote = "Quoted text could not be auto-located on the live page; contextual capture saved instead.";
          } catch {
            /* leave without targeted shot */
          }
          await removeStamp(page);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
