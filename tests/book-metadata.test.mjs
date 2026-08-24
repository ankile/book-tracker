import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenLibraryBook, deriveFiction, EMPTY_METADATA, METADATA_FIELDS } from "../src/lib/utils/bookMetadata.js";

test("METADATA_FIELDS mirrors EMPTY_METADATA", () => {
  assert.deepEqual(METADATA_FIELDS, Object.keys(EMPTY_METADATA));
});

test("full record parses into the metadata shape", () => {
  const parsed = parseOpenLibraryBook({
    title: "Circe",
    authors: [{ name: "Madeline Miller" }],
    number_of_pages: 393,
    cover: {
      small: "https://covers.openlibrary.org/b/id/8283869-S.jpg",
      medium: "https://covers.openlibrary.org/b/id/8283869-M.jpg",
      large: "https://covers.openlibrary.org/b/id/8283869-L.jpg",
    },
    publishers: [{ name: "Little, Brown and Company" }],
    publish_date: "April 10th 2018",
    subjects: [{ name: "Fantasy" }, { name: "Historical Fiction" }],
  });
  assert.equal(parsed.title, "Circe");
  assert.deepEqual(parsed.authorNames, ["Madeline Miller"]);
  assert.equal(parsed.pageCount, 393);
  assert.equal(parsed.coverUrl, "https://covers.openlibrary.org/b/id/8283869-M.jpg");
  assert.equal(parsed.publisher, "Little, Brown and Company");
  assert.equal(parsed.publishedDate, "April 10th 2018");
  assert.deepEqual(parsed.subjects, ["Fantasy", "Historical Fiction"]);
  assert.equal(parsed.fiction, true);
});

test("sparse record falls back to the empty defaults", () => {
  const parsed = parseOpenLibraryBook({ title: "Bare" });
  for (const field of METADATA_FIELDS) {
    assert.deepEqual(parsed[field], EMPTY_METADATA[field]);
  }
  assert.deepEqual(parsed.authorNames, []);
});

test("feed tags and duplicates are dropped from subjects", () => {
  const parsed = parseOpenLibraryBook({
    subjects: [
      { name: "Fantasy" },
      { name: "nyt:combined-print-and-e-book-fiction=2018-04-29" },
      { name: "New York Times bestseller" },
      { name: "fantasy" },
      { name: "  " },
    ],
  });
  assert.deepEqual(parsed.subjects, ["Fantasy", "New York Times bestseller"]);
});

test("fiction: a fiction subject classifies the book", () => {
  assert.equal(deriveFiction(["Historical Fiction"]), true);
  assert.equal(deriveFiction(["Fiction, fantasy, historical"]), true);
});

test("fiction: nonfiction-only subjects mean false", () => {
  assert.equal(deriveFiction(["Juvenile Nonfiction", "History"]), false);
  assert.equal(deriveFiction(["Non-fiction"]), false);
});

test("fiction: a fiction match wins over a stray nonfiction tag", () => {
  assert.equal(deriveFiction(["Juvenile Nonfiction", "Science Fiction"]), true);
});

test("fiction: no signal means unknown (null)", () => {
  assert.equal(deriveFiction(["Cognitive psychology", "Decision making"]), null);
  assert.equal(deriveFiction([]), null);
});

test("fiction: 'nonfiction' does not read as a fiction word match", () => {
  assert.equal(deriveFiction(["Creative nonfiction"]), false);
});
