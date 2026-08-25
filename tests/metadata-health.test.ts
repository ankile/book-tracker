import assert from "node:assert/strict";
import test from "node:test";

import {
  metadataStatus, groupByStatus, countIsbnProblems,
  ISBN_MISSING, ISBN_INVALID, NO_METADATA, COVER_MISSING,
} from "../src/lib/utils/metadataHealth.ts";

const enriched = { isbn: "9780316556347", coverUrl: "https://c/1.jpg", subjects: ["Fiction"], fiction: true };

test("a fully enriched book has no status", () => {
  assert.equal(metadataStatus(enriched), null);
});

test("an empty or absent isbn outranks every other problem", () => {
  assert.equal(metadataStatus({ isbn: "", coverUrl: "", subjects: [], fiction: null }), ISBN_MISSING);
  assert.equal(metadataStatus({ coverUrl: "https://c/1.jpg", subjects: ["X"], fiction: true }), ISBN_MISSING);
});

test("a checksum-invalid isbn is reported as invalid", () => {
  assert.equal(metadataStatus({ ...enriched, isbn: "9780316556348" }), ISBN_INVALID);
  assert.equal(metadataStatus({ ...enriched, isbn: "11412" }), ISBN_INVALID);
});

test("a valid isbn that yielded nothing at all is 'no metadata'", () => {
  assert.equal(metadataStatus({ isbn: "9780316556347", coverUrl: "", subjects: [], fiction: null }), NO_METADATA);
});

test("partial metadata without a cover is only a missing cover", () => {
  assert.equal(metadataStatus({ isbn: "9780316556347", coverUrl: "", subjects: ["Fiction"], fiction: null }), COVER_MISSING);
  // Classified but coverless counts as partial too, not as 'nothing found'.
  assert.equal(metadataStatus({ isbn: "9780316556347", coverUrl: "", subjects: [], fiction: false }), COVER_MISSING);
});

test("an ISBN-10 stored verbatim is valid, not invalid", () => {
  assert.equal(metadataStatus({ ...enriched, isbn: "0316556343" }), null);
});

test("grouping orders by severity and drops healthy books", () => {
  const groups = groupByStatus([
    enriched,
    { id: "a", isbn: "", coverUrl: "", subjects: [], fiction: null },
    { id: "b", isbn: "9780316556347", coverUrl: "", subjects: ["X"], fiction: null },
    { id: "c", isbn: "bogus", coverUrl: "", subjects: [], fiction: null },
  ]);
  assert.deepEqual(groups.map((g) => g.status), [ISBN_MISSING, ISBN_INVALID, COVER_MISSING]);
  assert.deepEqual(groups.map((g) => g.books.length), [1, 1, 1]);
});

test("the card count covers only the isbn problems", () => {
  const books = [
    enriched,
    { isbn: "", coverUrl: "", subjects: [], fiction: null },
    { isbn: "nope", coverUrl: "", subjects: [], fiction: null },
    { isbn: "9780316556347", coverUrl: "", subjects: ["X"], fiction: null },
  ];
  assert.equal(countIsbnProblems(books), 2);
});
