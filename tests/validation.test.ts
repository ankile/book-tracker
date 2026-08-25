import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateBookPages,
  validateBookTitle,
  validateCurrentPage,
  validateReading,
} from '../src/lib/utils/validation.ts';

test('reading validation accepts Svelte numeric bindings and returns normalized values', () => {
  assert.deepEqual(
    validateReading({ inputTime: 45, inputPages: 120, previousPage: 100, pageCount: 300 }),
    { valid: true, time: 45, pages: 120 },
  );
  assert.deepEqual(
    validateReading({ inputTime: 45, inputPages: 100, previousPage: 100, pageCount: 300 }),
    { valid: true, time: 45, pages: 100 },
  );
});

test('book page validation requires positive integer bounds', () => {
  assert.deepEqual(validateBookPages({ pageCount: 300, currentPage: 0 }), {
    valid: true,
    pageCount: 300,
    currentPage: 0,
  });
  assert.equal(validateBookPages({ pageCount: 300.5, currentPage: 1 }).valid, false);
  assert.equal(validateBookPages({ pageCount: 0, currentPage: 0 }).valid, false);
  assert.equal(validateBookPages({ pageCount: 300, currentPage: 1.5 }).valid, false);
  assert.equal(validateBookPages({ pageCount: 300, currentPage: 301 }).valid, false);
  assert.equal(
    validateBookPages({ pageCount: Number.MAX_SAFE_INTEGER + 1, currentPage: 1 }).valid,
    false,
  );
  assert.equal(
    validateBookPages({ pageCount: '9007199254740992', currentPage: 1 }).valid,
    false,
  );
});

test('book title validation trims and bounds persisted queue descriptions', () => {
  assert.deepEqual(validateBookTitle('  A   Book  '), { valid: true, title: 'A Book' });
  assert.equal(validateBookTitle('   ').valid, false);
  assert.equal(validateBookTitle('x'.repeat(501)).valid, false);
});

test('reading validation distinguishes empty and invalid numeric input', () => {
  assert.equal(
    validateReading({ inputTime: undefined, inputPages: 120, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
  assert.equal(
    validateReading({ inputTime: 45, inputPages: Number.NaN, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
  assert.equal(
    validateReading({ inputTime: 2.5, inputPages: 120, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
});

test('reading validation rejects non-positive time and pages outside the book', () => {
  assert.equal(
    validateReading({ inputTime: -1, inputPages: 120, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
  assert.equal(
    validateReading({ inputTime: 45, inputPages: 99, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
  assert.equal(
    validateReading({ inputTime: 45, inputPages: 301, previousPage: 100, pageCount: 300 }).valid,
    false,
  );
});

test('current-page validation returns the normalized page', () => {
  assert.deepEqual(validateCurrentPage({ inputPages: '42', pageCount: 300 }), {
    valid: true,
    page: 42,
  });
  assert.equal(validateCurrentPage({ inputPages: '', pageCount: 300 }).valid, false);
  assert.equal(validateCurrentPage({ inputPages: -1, pageCount: 300 }).valid, false);
  assert.equal(validateCurrentPage({ inputPages: 301, pageCount: 300 }).valid, false);
});
