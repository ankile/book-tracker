import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorIdFor,
  splitAuthors,
  joinAuthors,
  resolveChip,
  abbreviatedName,
  formatAuthors,
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

test('placeholder attributions are ordinary names, not special-cased', () => {
  assert.deepEqual(splitAuthors('Various Authors'), ['Various Authors']);
  assert.deepEqual(
    splitAuthors('Various Authors & Tolkien'),
    ['Various Authors', 'Tolkien'],
  );
});

test('joinAuthors round-trips through splitAuthors', () => {
  const names = ['Daniel Kahneman', 'Amos Tversky'];
  assert.deepEqual(splitAuthors(joinAuthors(names)), names);
});

test('resolveChip matches loaded authors by name, else mints a new chip', () => {
  const authors = [
    { id: 'daniel kahneman', name: 'Daniel Kahneman', nameLower: 'daniel kahneman', kind: 'person' },
  ];
  assert.deepEqual(
    resolveChip('  daniel   KAHNEMAN ', authors),
    { id: 'daniel kahneman', name: 'Daniel Kahneman' },
  );
  assert.deepEqual(
    resolveChip('  Amos  Tversky ', authors),
    { id: null, name: 'Amos Tversky' },
  );
});

test('resolveChip matches a renamed author by its creation-time id', () => {
  // Doc created as "J.R.R. Tolkien", later renamed: id stays, name changes.
  const authors = [
    { id: 'j.r.r. tolkien', name: 'John Ronald Reuel Tolkien', nameLower: 'john ronald reuel tolkien', kind: 'person' },
  ];
  // Typing the pre-rename name must resolve to the renamed doc, not mint a
  // colliding "new" author that would revert the rename.
  assert.deepEqual(
    resolveChip('J.R.R. Tolkien', authors),
    { id: 'j.r.r. tolkien', name: 'John Ronald Reuel Tolkien' },
  );
});

test('abbreviatedName takes the last token for persons', () => {
  assert.equal(abbreviatedName({ name: 'J. R. R. Tolkien', kind: 'person' }), 'Tolkien');
  // Documented limitation: multi-token surnames lose their particle —
  // that is what sortName is for.
  assert.equal(abbreviatedName({ name: 'Ursula K. Le Guin', kind: 'person' }), 'Guin');
});

test('abbreviatedName prefers sortName over any rule', () => {
  assert.equal(
    abbreviatedName({ name: 'Ursula K. Le Guin', kind: 'person', sortName: 'Le Guin' }),
    'Le Guin',
  );
});

test('abbreviatedName keeps the full name for non-person kinds', () => {
  assert.equal(
    abbreviatedName({ name: 'Harvard  Business Review', kind: 'entity' }),
    'Harvard Business Review',
  );
  assert.equal(
    abbreviatedName({ name: 'Various Authors', kind: 'placeholder' }),
    'Various Authors',
  );
});

test('abbreviatedName treats kindless legacy entries as persons', () => {
  // Legacy {id, name} entries embedded on unmigrated books carry no kind.
  assert.equal(abbreviatedName({ id: 'x', name: 'Amos Tversky' }), 'Tversky');
});

test('formatAuthors renders 0, 1, 2, and 3+ authors', () => {
  const a = (name) => ({ id: authorIdFor(name), name, kind: 'person' });
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

test('formatAuthors respects kind in multi-author lists', () => {
  const hbr = { id: 'harvard business review', name: 'Harvard Business Review', kind: 'entity' };
  const p = (name) => ({ id: authorIdFor(name), name, kind: 'person' });
  assert.equal(
    formatAuthors([hbr, p('Clayton Christensen')]),
    'Harvard Business Review & Christensen',
  );
  assert.equal(
    formatAuthors([hbr, p('Clayton Christensen'), p('Michael Porter')]),
    'Harvard Business Review et al.',
  );
});
