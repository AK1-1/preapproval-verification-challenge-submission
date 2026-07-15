import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const CONFIG_PATH = path.join(ROOT, "config", "checklists.json");
export const REPORTS_DIR = path.join(ROOT, "reports");
export const SAMPLES_DIR = path.join(ROOT, "samples");
export const UPLOADS_DIR = path.join(ROOT, "uploads");

export function loadChecklists() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

/**
 * Resolve a category config, applying `extends` (used by the Appeal
 * category, which re-runs the Community Classes checks).
 */
export function resolveCategory(key) {
  const cfg = loadChecklists();
  const cat = cfg.categories[key];
  if (!cat) return null;
  if (!cat.extends) return { key, ...cat };
  const base = cfg.categories[cat.extends];
  if (!base) throw new Error(`Category '${key}' extends unknown '${cat.extends}'`);
  return {
    key,
    ...base,
    ...cat,
    webChecks: cat.webChecks || base.webChecks,
    capNotes: [...(base.capNotes || []), ...(cat.capNotes || [])],
  };
}

export function categoryKeys() {
  return Object.keys(loadChecklists().categories);
}
