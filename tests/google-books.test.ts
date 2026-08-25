import assert from "node:assert/strict";
import test from "node:test";

import { parseGoogleVolume, deriveFictionFromCategories, mergeMetadata } from "../src/lib/utils/googleBooks.ts";
import { EMPTY_METADATA, METADATA_FIELDS } from "../src/lib/utils/bookMetadata.ts";

test("volume parses into the metadata shape", () => {
  const parsed = parseGoogleVolume({
    title: "CIRCE",
    authors: ["Madeline Miller"],
    publisher: "Little, Brown",
    publishedDate: "2018-04-10",
    pageCount: 393,
    categories: ["Fiction"],
    imageLinks: { thumbnail: "https://books.google.com/books/content?id=W6j2" },
  });
  assert.equal(parsed.title, "CIRCE");
  assert.deepEqual(parsed.authorNames, ["Madeline Miller"]);
  assert.equal(parsed.pageCount, 393);
  assert.equal(parsed.publisher, "Little, Brown");
  assert.equal(parsed.publishedDate, "2018-04-10");
  assert.deepEqual(parsed.subjects, ["Fiction"]);
  assert.equal(parsed.fiction, true);
});

test("http thumbnails are upgraded to https (mixed content would be blocked)", () => {
  const parsed = parseGoogleVolume({ imageLinks: { thumbnail: "http://books.google.com/x.jpg" } });
  assert.equal(parsed.coverUrl, "https://books.google.com/x.jpg");
});

test("a volume with nothing useful yields the empty defaults", () => {
  const parsed = parseGoogleVolume({});
  for (const field of METADATA_FIELDS) {
    assert.deepEqual(parsed[field], EMPTY_METADATA[field]);
  }
});

test("malformed optional Google Books fields degrade independently", () => {
  const parsed = parseGoogleVolume({
    title: 42,
    authors: ["Valid Author", null, 7],
    publisher: false,
    publishedDate: { year: 2018 },
    pageCount: "393",
    categories: [" Fiction ", null, 9, ""],
    imageLinks: { thumbnail: 12 },
  });
  assert.equal(parsed.title, "");
  assert.deepEqual(parsed.authorNames, ["Valid Author"]);
  assert.equal(parsed.pageCount, undefined);
  assert.equal(parsed.coverUrl, "");
  assert.equal(parsed.publisher, "");
  assert.equal(parsed.publishedDate, "");
  assert.deepEqual(parsed.subjects, ["Fiction"]);
  assert.equal(parsed.fiction, true);

  assert.deepEqual(parseGoogleVolume({ authors: "Wrong container" }).authorNames, []);
  assert.equal(parseGoogleVolume({ pageCount: Number.POSITIVE_INFINITY }).pageCount, undefined);
});

test("a Google Books volume must be an object", () => {
  assert.throws(() => parseGoogleVolume(null), /must be an object/);
  assert.throws(() => parseGoogleVolume([]), /must be an object/);
});

test("Google Books rejects non-positive, fractional, and unsafe page counts", () => {
  for (const pageCount of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseGoogleVolume({ pageCount }).pageCount, undefined);
  }
});

test("BISAC non-fiction headings classify as non-fiction", () => {
  assert.equal(deriveFictionFromCategories(["Business & Economics"]), false);
  assert.equal(deriveFictionFromCategories(["Biography & Autobiography"]), false);
  assert.equal(deriveFictionFromCategories(["Science"]), false);
});

test("fiction headings and sub-headings classify as fiction", () => {
  assert.equal(deriveFictionFromCategories(["Fiction"]), true);
  assert.equal(deriveFictionFromCategories(["Juvenile Fiction"]), true);
  assert.equal(deriveFictionFromCategories(["Fiction / Fantasy / Epic"]), true);
});

test("slash sub-headings resolve on their top level", () => {
  assert.equal(deriveFictionFromCategories(["Science / Physics"]), false);
});

test("unrecognized or empty categories stay unknown", () => {
  assert.equal(deriveFictionFromCategories(["Texas"]), null);
  assert.equal(deriveFictionFromCategories([]), null);
});

test("merge fills only empty fields and reports just the patch", () => {
  const existing = { coverUrl: "", publisher: "Vintage", publishedDate: "", subjects: [], fiction: null };
  const incoming = { coverUrl: "https://x/y.jpg", publisher: "Little, Brown", publishedDate: "2018", subjects: ["Fiction"], fiction: true };
  assert.deepEqual(mergeMetadata(existing, incoming), {
    coverUrl: "https://x/y.jpg",
    publishedDate: "2018",
    subjects: ["Fiction"],
    fiction: true,
  });
});

test("merge leaves a fully populated book untouched", () => {
  const existing = { coverUrl: "https://a", publisher: "P", publishedDate: "2001", subjects: ["X"], fiction: false };
  assert.deepEqual(mergeMetadata(existing, { coverUrl: "https://b", publisher: "Q", publishedDate: "2002", subjects: ["Y"], fiction: true }), {});
});

test("merge treats fiction:false as filled, not as a gap", () => {
  const existing = { ...EMPTY_METADATA, fiction: false };
  const patch = mergeMetadata(existing, { ...EMPTY_METADATA, fiction: true });
  assert.equal("fiction" in patch, false);
});
