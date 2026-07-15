#!/usr/bin/env node
/**
 * CLI runner: node backend/testRunner.js [sample-pdf ...]
 * With no arguments it runs the three demonstration samples
 * (easy case, exclusion trap, appeal).
 */
import path from "path";
import fs from "fs";
import { runPipeline } from "./pipeline.js";
import { SAMPLES_DIR } from "./lib/config.js";
import { displayStatus } from "./lib/labels.js";

const DEFAULT_SAMPLES = [
  "Sample-01---Community-Class-GallopNYC.pdf",
  "Sample-07---HRI-Laptop---exclusion-test.pdf",
  "Sample-10---Appeal-Gracie-Barra-Jiu-Jitsu.pdf",
];

const args = process.argv.slice(2);
const files = (args.length ? args : DEFAULT_SAMPLES).map((f) =>
  path.isAbsolute(f) ? f : fs.existsSync(f) ? path.resolve(f) : path.join(SAMPLES_DIR, f)
);

let failures = 0;
for (const file of files) {
  console.log(`\n========== ${path.basename(file)} ==========`);
  if (!fs.existsSync(file)) {
    console.error(`  NOT FOUND: ${file}`);
    failures++;
    continue;
  }
  try {
    const state = await runPipeline(file, {
      onProgress: (msg) => console.log(`  • ${msg}`),
    });
    console.log(`\n  Summary for ${state.parsed.participantName} — ${state.parsed.requestedItem}:`);
    console.log(`    Rate verdict: ${state.rateComparison?.verdict}`);
    for (const f of state.findings) {
      console.log(`    [${displayStatus(f.status)}] ${f.label}`);
    }
    if (state.needsClarification) {
      console.log(`    ⚠ Clarification needed: ${state.parsed.missingInfo.join(" | ")}`);
    }
  } catch (err) {
    console.error(`  PIPELINE FAILED: ${err.message}`);
    failures++;
  }
}
process.exit(failures ? 1 : 0);
