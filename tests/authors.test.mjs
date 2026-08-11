import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorIdFor,
  splitAuthors,
  joinAuthors,
  lastNameOf,
  formatAuthors,
  isPlaceholderAuthor,
} from '../src/lib/utils/authors.js';

test('authorIdFor normalizes case, whitespace, and slashes', () => {
  assert.equal(authorIdFor('  J.  R. R.   Tolkien '), 'j. r. r. tolkien');
  assert.equal(authorIdFor('AC/DC'), 'ac_dc');
});

test('splitAuthors splits on ampersands', () => {
  assert.deepEqual(splitAuthors('Kahneman & Tversky'), ['Kahneman', 'Tversky']);
});

test('splitAuthors splits on commas and strips the Oxford "and"', () => {
  assert.deepEqual(
    splitAuthors('Dawkins, Dennett, Harris, and Hitchens'),
    ['Dawkins', 'Dennett', 'Harris', 'Hitchens'],
  );
});

test('splitAuthors handles mixed separators', () => {
  assert.deepEqual(
    splitAuthors('Savoie, Stadler & Shann'),
    ['Savoie', 'Stadler', 'Shann'],
  );
});

test('splitAuthors keeps "and" inside a name', () => {
  assert.deepEqual(splitAuthors('Alexandra Andhover'), ['Alexandra Andhover']);
});

test('splitAuthors returns a single full name untouched', () => {
  assert.deepEqual(splitAuthors('J. R. R. Tolkien'), ['J. R. R. Tolkien']);
});

test('splitAuthors drops empties and dedupes by id', () => {
  assert.deepEqual(splitAuthors(''), []);
  assert.deepEqual(splitAuthors(' , '), []);
  assert.deepEqual(splitAuthors('Tolkien, tolkien'), ['Tolkien']);
});

test('placeholder attributions are recognized and never become entities', () => {
  assert.ok(isPlaceholderAuthor('Various Authors'));
  assert.ok(isPlaceholderAuthor('  various  authors '));
  assert.ok(isPlaceholderAuthor('Unknown'));
  assert.ok(!isPlaceholderAuthor('Vario Us'));
  assert.deepEqual(splitAuthors('Various Authors'), []);
  assert.deepEqual(splitAuthors('Various Authors & Tolkien'), ['Tolkien']);
});

test('joinAuthors round-trips through splitAuthors', () => {
  const names = ['Daniel Kahneman', 'Amos Tversky'];
  assert.deepEqual(splitAuthors(joinAuthors(names)), names);
});

test('lastNameOf takes the last whitespace token', () => {
  assert.equal(lastNameOf('J. R. R. Tolkien'), 'Tolkien');
  // Documented limitation: multi-token surnames lose their particle.
  assert.equal(lastNameOf('Ursula K. Le Guin'), 'Guin');
});

test('corporate authors keep their full name in abbreviations', () => {
  assert.equal(lastNameOf('Harvard  Business Review'), 'Harvard Business Review');
  const a = (name) => ({ id: authorIdFor(name), name });
  assert.equal(
    formatAuthors([a('Harvard Business Review'), a('Clayton Christensen')]),
    'Harvard Business Review & Christensen',
  );
  assert.equal(
    formatAuthors([a('Harvard Business Review'), a('Clayton Christensen'), a('Michael Porter')]),
    'Harvard Business Review et al.',
  );
});

test('formatAuthors renders 0, 1, 2, and 3+ authors', () => {
  const a = (name) => ({ id: authorIdFor(name), name });
  assert.equal(formatAuthors([]), '');
  // A lone author keeps the full name; only lists abbreviate.
  assert.equal(formatAuthors([a('J. R. R. Tolkien')]), 'J. R. R. Tolkien');
  assert.equal(
    formatAuthors([a('Daniel Kahneman'), a('Amos Tversky')]),
    'Kahneman & Tversky',
  );
  assert.equal(
    formatAuthors([a('Daniel Kahneman'), a('Amos Tversky'), a('Richard Thaler')]),
    'Kahneman et al.',
  );
});
