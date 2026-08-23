import assert from "node:assert/strict";
import test from "node:test";

import { formatDateRange, formatMonthYear, formatTime } from "../src/lib/utils/format.js";

test("formatTime renders hh:mm", () => {
  assert.equal(formatTime(90), "01:30");
  assert.equal(formatTime(0), "00:00");
});

test("formatMonthYear renders short month and year", () => {
  assert.equal(formatMonthYear(new Date(2018, 7, 15)), "Aug 2018");
});

test("formatDateRange spans years with one-decimal year count", () => {
  assert.equal(
    formatDateRange(new Date(2018, 7, 1), new Date(2026, 7, 1)),
    "Aug 2018 – Aug 2026 · 8.0 yrs"
  );
});

test("formatDateRange under a year reads in months", () => {
  assert.equal(
    formatDateRange(new Date(2026, 0, 10), new Date(2026, 6, 10)),
    "Jan 2026 – Jul 2026 · 6 mos"
  );
});

test("formatDateRange collapses a same-month range", () => {
  assert.equal(
    formatDateRange(new Date(2026, 7, 2), new Date(2026, 7, 20)),
    "Aug 2026"
  );
});
