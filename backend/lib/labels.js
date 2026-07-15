/**
 * Reviewer-facing wording for the canonical status values.
 * Canonical values ("Met" / "Not Met" / "Needs Review" / "Internal") stay
 * stable in report.json and the evaluation logic; only the display changes.
 */
export const STATUS_LABELS = {
  Met: "Match/Pass",
  "Not Met": "No Match/Fail",
  "Needs Review": "Needs Review",
  Internal: "Internal",
};

export function displayStatus(status) {
  return STATUS_LABELS[status] || status;
}
