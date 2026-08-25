import assert from "node:assert/strict";
import test from "node:test";

import { isFinished } from "../src/lib/utils/finished.ts";

test("equal numeric pages mean finished", () => {
  assert.equal(isFinished(300, 300), true);
});

test("unequal pages mean not finished", () => {
  assert.equal(isFinished(250, 300), false);
});

test("missing pageCount (empty form field) means not finished", () => {
  assert.equal(isFinished(1, undefined), false);
});

test("missing both page fields means not finished", () => {
  // The old trigger's undefined === undefined bug must not exist here.
  assert.equal(isFinished(undefined, undefined), false);
});

test("string pages (unparsed input) mean not finished", () => {
  assert.equal(isFinished("300", "300"), false);
});
