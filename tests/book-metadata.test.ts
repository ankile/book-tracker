import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOpenLibraryBook,
  deriveFiction,
  EMPTY_METADATA,
  METADATA_FIELDS,
  selectLookupMetadata,
} from "../src/lib/utils/bookMetadata.ts";

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

test("malformed optional Open Library fields degrade independently", () => {
  const parsed = parseOpenLibraryBook({
    title: 42,
    authors: [null, { name: "Valid Author" }, { name: 7 }],
    number_of_pages: "393",
    cover: { medium: false },
    publishers: [{ name: 8 }, { name: "Valid Publisher" }],
    publish_date: { year: 2018 },
    subjects: [null, { name: 3 }, { name: " Historical Fiction " }],
  });
  assert.equal(parsed.title, "");
  assert.deepEqual(parsed.authorNames, ["Valid Author"]);
  assert.equal(parsed.pageCount, undefined);
  assert.equal(parsed.coverUrl, "");
  assert.equal(parsed.publisher, "Valid Publisher");
  assert.equal(parsed.publishedDate, "");
  assert.deepEqual(parsed.subjects, ["Historical Fiction"]);
  assert.equal(parsed.fiction, true);

  assert.deepEqual(parseOpenLibraryBook({ authors: { name: "Wrong container" } }).authorNames, []);
});

test("an Open Library record must be an object", () => {
  assert.throws(() => parseOpenLibraryBook(null), /must be an object/);
  assert.throws(() => parseOpenLibraryBook([]), /must be an object/);
});

test("Open Library rejects non-positive, fractional, and unsafe page counts", () => {
  for (const pageCount of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseOpenLibraryBook({ number_of_pages: pageCount }).pageCount, undefined);
  }
});

test("feed tags, generic labels, and duplicates are dropped from subjects", () => {
  const parsed = parseOpenLibraryBook({
    subjects: [
      { name: "Fantasy" },
      { name: "nyt:combined-print-and-e-book-fiction=2018-04-29" },
      { name: "New York Times bestseller" },
      { name: "Fiction, general" },
      { name: "Nonfiction" },
      { name: "fantasy" },
      { name: "  " },
    ],
  });
  assert.deepEqual(parsed.subjects, ["Fantasy", "New York Times bestseller"]);
});

test("Google cover and classification win while Open Library subjects stay detailed", () => {
  const openLibrary = parseOpenLibraryBook({
    title: "The mind of the strategist",
    cover: { medium: "https://covers.openlibrary.org/b/id/8666170-M.jpg" },
    publishers: [{ name: "McGraw-Hill" }],
    publish_date: "1982",
    subjects: [
      { name: "Industrial management" },
      { name: "Strategy" },
      { name: "Corporate planning" },
      { name: "Fiction, general" },
    ],
  });
  const google = {
    ...EMPTY_METADATA,
    coverUrl: "https://books.google.com/books/content?id=mXIiDxQAdbsC",
    publisher: "McGraw-Hill Education",
    subjects: ["Business & Economics"],
    fiction: false,
  };

  assert.deepEqual(selectLookupMetadata(openLibrary, google, null), {
    coverUrl: "https://books.google.com/books/content?id=mXIiDxQAdbsC",
    publisher: "McGraw-Hill",
    publishedDate: "1982",
    subjects: ["Industrial management", "Strategy", "Corporate planning"],
    fiction: false,
    language: "",
  });
});

test("metadata selection falls back field by field when preferred sources have gaps", () => {
  const openLibrary = {
    ...EMPTY_METADATA,
    coverUrl: "https://covers.openlibrary.org/cover.jpg",
    subjects: ["Historical Fiction"],
    fiction: true,
  };
  const google = { ...EMPTY_METADATA, publisher: "Google Publisher" };
  const nationalLibrary = {
    ...EMPTY_METADATA,
    publishedDate: "2020",
    subjects: ["Romaner"],
    fiction: false,
  };

  assert.deepEqual(selectLookupMetadata(openLibrary, google, nationalLibrary), {
    coverUrl: "https://covers.openlibrary.org/cover.jpg",
    publisher: "Google Publisher",
    publishedDate: "2020",
    subjects: ["Historical Fiction"],
    fiction: false,
    language: "",
  });
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

test("language comes from Google first, then the national library", () => {
  const google = { ...EMPTY_METADATA, language: "en" };
  const nationalLibrary = { ...EMPTY_METADATA, language: "no" };
  assert.equal(selectLookupMetadata(null, google, nationalLibrary).language, "en");
  assert.equal(selectLookupMetadata(null, null, nationalLibrary).language, "no");
  assert.equal(selectLookupMetadata({ ...EMPTY_METADATA }, { ...EMPTY_METADATA }, null).language, "");
});
