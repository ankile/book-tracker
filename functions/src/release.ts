export const RELEASE_ID = "security-2026-08-26-01";
export const RELEASE_HEADER = "X-Book-Tracker-Release";

export function releaseLabels(): Record<string, string> {
  return {"book-tracker-release": RELEASE_ID};
}
