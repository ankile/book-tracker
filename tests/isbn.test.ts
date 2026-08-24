import assert from "node:assert/strict";
import test from "node:test";

import { normalizeIsbn } from "../src/lib/utils/isbn.ts";

test("valid ISBN-13 passes through bare", () => {
  assert.equal(normalizeIsbn("9780316556347"), "9780316556347");
});

test("hyphens and spaces are stripped", () => {
  assert.equal(normalizeIsbn("978-0-316-55634-7"), "9780316556347");
  assert.equal(normalizeIsbn(" 978 0316556347 "), "9780316556347");
});

test("ISBN-10 converts to ISBN-13 with recomputed check digit", () => {
  // Circe: 0316556343 (ISBN-10) is 9780316556347 (ISBN-13).
  assert.equal(normalizeIsbn("0316556343"), "9780316556347");
});

test("ISBN-10 with X check digit converts", () => {
  assert.equal(normalizeIsbn("097522980X"), "9780975229804");
  assert.equal(normalizeIsbn("097522980x"), "9780975229804");
});

test("checksum-invalid input returns null", () => {
  assert.equal(normalizeIsbn("9780316556348"), null);
  assert.equal(normalizeIsbn("0316556344"), null);
});

test("wrong length or non-ISBN text returns null", () => {
  assert.equal(normalizeIsbn(""), null);
  assert.equal(normalizeIsbn("12345"), null);
  assert.equal(normalizeIsbn("not an isbn"), null);
});
