export function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60
  ).padStart(2, "0")}`;
}

export function formatMonthYear(date) {
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

// "Aug 2018 – Aug 2026 · 8.0 yrs" for the stat-card subtexts. Sub-year
// spans read in months, and a range within one calendar month collapses
// to that single month label.
export function formatDateRange(start, end) {
  const startLabel = formatMonthYear(start);
  const endLabel = formatMonthYear(end);
  if (startLabel === endLabel) return startLabel;
  const years = (end - start) / (1000 * 60 * 60 * 24 * 365.25);
  const span =
    years >= 1
      ? `${years.toFixed(1)} yrs`
      : `${Math.max(1, Math.round(years * 12))} mos`;
  return `${startLabel} – ${endLabel} · ${span}`;
}
