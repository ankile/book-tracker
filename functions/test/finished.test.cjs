const assert = require("node:assert/strict");
const test = require("node:test");

const {finishedTransition} = require("../lib/finished");

test("reaching the last page marks the book finished", () => {
  assert.deepEqual(
    finishedTransition(
      {currentPage: 250, pageCount: 300, finished: false},
      {currentPage: 300, pageCount: 300, finished: false},
    ),
    {finished: true},
  );
});

test("finished flag missing still resolves when pages become equal", () => {
  assert.deepEqual(
    finishedTransition(
      {currentPage: 250, pageCount: 300},
      {currentPage: 300, pageCount: 300},
    ),
    {finished: true},
  );
});

test("moving off the last page unmarks a finished book", () => {
  assert.deepEqual(
    finishedTransition(
      {currentPage: 300, pageCount: 300, finished: true},
      {currentPage: 250, pageCount: 300, finished: true},
    ),
    {finished: false},
  );
});

test("editing pageCount to match currentPage marks finished", () => {
  assert.deepEqual(
    finishedTransition(
      {currentPage: 280, pageCount: 300, finished: false},
      {currentPage: 280, pageCount: 280, finished: false},
    ),
    {finished: true},
  );
});

test("the trigger's own merge-set re-fire is a no-op", () => {
  assert.equal(
    finishedTransition(
      {currentPage: 300, pageCount: 300, finished: false},
      {currentPage: 300, pageCount: 300, finished: true},
    ),
    null,
  );
});

test("a client write that already set finished correctly is a no-op", () => {
  assert.equal(
    finishedTransition(
      {currentPage: 250, pageCount: 300, finished: false},
      {currentPage: 300, pageCount: 300, finished: true},
    ),
    null,
  );
});

test("non-page writes never touch a drifted finished flag", () => {
  // finished:true with unequal pages (legacy drift): an owner backfill,
  // authors migration, or activeTimer write must not flip it.
  assert.equal(
    finishedTransition(
      {currentPage: 250, pageCount: 300, finished: true},
      {currentPage: 250, pageCount: 300, finished: true, activeTimer: {}},
    ),
    null,
  );
});

test("legacy docs missing both page fields are never marked finished", () => {
  // The old handler's undefined === undefined bug: an unrelated write to a
  // doc with no page fields used to set finished true.
  assert.equal(
    finishedTransition(
      {finished: false},
      {finished: false, author: "backfilled"},
    ),
    null,
  );
});

test("a page field appearing as a non-number is a no-op", () => {
  assert.equal(
    finishedTransition(
      {currentPage: 300, finished: false},
      {currentPage: 300, pageCount: "300", finished: false},
    ),
    null,
  );
});

test("pages equal and already finished is a no-op", () => {
  assert.equal(
    finishedTransition(
      {currentPage: 299, pageCount: 300, finished: false},
      {currentPage: 300, pageCount: 300, finished: true},
    ),
    null,
  );
});
