import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The Svelte side cannot run under node:test; pin the wiring of the
// empty-library call to action on the main page.
const pageSource = readFileSync('src/routes/+page.svelte', 'utf8');

test('the main page offers the first book only once the whole library has loaded empty', () => {
  // Whole library, not the unfinished subset BookList shows: "no books
  // whatsoever" is the condition.
  assert.match(pageSource, /Database\.getAllBooks\(current\.uid\)/);
  // undefined is the not-yet-loaded sentinel; the button must not flash
  // over a list that is still loading.
  assert.match(pageSource, /allBooks !== undefined && allBooks\.length === 0/);
  assert.match(pageSource, /\{#if libraryEmpty\}[\s\S]*?Add your first book[\s\S]*?\{\/if\}/);
});

test('the first-book button opens the same add-book modal as /me', () => {
  assert.match(pageSource, /import NewBookModal from '\$lib\/components\/NewBookModal\.svelte';/);
  assert.match(pageSource, /onclick=\{\(\) => \(firstBookModal = true\)\}/);
  assert.match(pageSource, /<NewBookModal open=\{firstBookModal\} onclose=\{\(\) => \(firstBookModal = false\)\} userId=\{\$user\.uid\} \/>/);
});
