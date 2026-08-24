import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorIdFor,
  splitAuthors,
  joinAuthors,
  splitPersonName,
  joinPersonName,
  resolveChip,
  canonicalAuthorIds,
  selectableAuthors,
  bookAuthors,
  abbreviatedName,
  formatAuthors,
} from '../src/lib/utils/authors.ts';
import type { DisplayAuthor } from '../src/lib/utils/authors.ts';
import type { Author } from '../src/lib/interfaces/author.ts';

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

test('splitPersonName prefills last token as family name, round-trips through join', () => {
  assert.deepEqual(splitPersonName(' J.  R. R.  Tolkien '), { givenName: 'J. R. R.', familyName: 'Tolkien' });
  // Mononyms are family-name-only.
  assert.deepEqual(splitPersonName('Homer'), { givenName: '', familyName: 'Homer' });
  assert.equal(joinPersonName(splitPersonName('Daniel Kahneman')), 'Daniel Kahneman');
  assert.equal(joinPersonName({ givenName: '', familyName: 'Homer' }), 'Homer');
  // The prefill is editable, which is the whole point: the corrected
  // parts still join to a display name.
  assert.equal(joinPersonName({ givenName: 'Ursula K.', familyName: 'Le Guin' }), 'Ursula K. Le Guin');
});

test('resolveChip matches loaded authors by name, else mints a new person chip with parts', () => {
  const authors = [
    { id: 'daniel kahneman', name: 'Daniel Kahneman', nameLower: 'daniel kahneman', kind: 'person' },
  ];
  assert.deepEqual(
    resolveChip('  daniel   KAHNEMAN ', authors),
    { id: 'daniel kahneman', name: 'Daniel Kahneman' },
  );
  assert.deepEqual(
    resolveChip('  Amos  Tversky ', authors),
    { id: null, name: 'Amos Tversky', kind: 'person', givenName: 'Amos', familyName: 'Tversky' },
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

test('bookAuthors resolves normalized ids and keeps legacy authorship authoritative', () => {
  const tolkien: Author = {
    id: 'tolkien',
    name: 'J. R. R. Tolkien',
    nameLower: 'j. r. r. tolkien',
    kind: 'person',
    givenName: 'J. R. R.',
    familyName: 'Tolkien',
  };
  const authors = new Map([[tolkien.id, tolkien]]);

  assert.deepEqual(bookAuthors({ authorIds: ['tolkien'] }, authors), [tolkien]);
  assert.equal(bookAuthors({ authorIds: ['tolkien'] }, null), null);
  assert.deepEqual(
    bookAuthors({ author: 'Legacy Name', authorIds: ['tolkien'] }, authors),
    [{ name: 'Legacy Name' }],
  );
});

test('bookAuthors rejects corrupt normalized joins', () => {
  assert.throws(
    () => bookAuthors({ authorIds: ['missing'] }, new Map()),
    /Missing author document: missing/,
  );
  assert.throws(
    () => bookAuthors({}, new Map()),
    /neither legacy authorship nor authorIds/,
  );
});

test('merged authors resolve transitively and deleted authors stay non-selectable', () => {
  const target: Author = {
    id: 'target',
    name: 'Target Author',
    nameLower: 'target author',
    kind: 'person',
    givenName: 'Target',
    familyName: 'Author',
  };
  const source: Author = {
    id: 'source',
    name: 'Old Author',
    nameLower: 'old author',
    kind: 'person',
    givenName: 'Old',
    familyName: 'Author',
    retirement: { reason: 'merged', targetId: 'target' },
  };
  const deleted: Author = {
    id: 'deleted',
    name: 'Deleted Author',
    nameLower: 'deleted author',
    kind: 'person',
    givenName: 'Deleted',
    familyName: 'Author',
    retirement: { reason: 'deleted' },
  };
  const authorMap = new Map([source, target, deleted].map((author) => [author.id, author]));

  assert.deepEqual(canonicalAuthorIds(['source', 'target'], authorMap), ['target']);
  assert.deepEqual(bookAuthors({ authorIds: ['source'] }, authorMap), [target]);
  assert.deepEqual(bookAuthors({
    authors: [
      {id: 'source', name: 'Old Author'},
      {id: 'target', name: 'Target Author'},
    ],
  }, authorMap), [target]);
  assert.deepEqual(selectableAuthors([source, target, deleted]), [target]);
  assert.deepEqual(resolveChip('Old Author', [source, target, deleted]), {
    id: 'target',
    name: 'Target Author',
  });
});

test('author redirect cycles crash as corrupt data', () => {
  const first: Author = {
    id: 'first', name: 'First', nameLower: 'first', kind: 'person', familyName: 'First',
    retirement: { reason: 'merged', targetId: 'second' },
  };
  const second: Author = {
    id: 'second', name: 'Second', nameLower: 'second', kind: 'person', familyName: 'Second',
    retirement: { reason: 'merged', targetId: 'first' },
  };
  const authorMap = new Map([[first.id, first], [second.id, second]]);
  assert.throws(() => canonicalAuthorIds(['first'], authorMap), /Cyclic author merge/);
});

test('abbreviatedName reads the explicit familyName for persons', () => {
  assert.equal(abbreviatedName({ name: 'J. R. R. Tolkien', kind: 'person', givenName: 'J. R. R.', familyName: 'Tolkien' }), 'Tolkien');
  // Multi-token surnames are exactly why the parts are explicit: the
  // entry form captured "Le Guin", so no heuristic can mangle it.
  assert.equal(
    abbreviatedName({ name: 'Ursula K. Le Guin', kind: 'person', givenName: 'Ursula K.', familyName: 'Le Guin' }),
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
  const a = (name: string): DisplayAuthor => ({
    id: authorIdFor(name),
    name,
    kind: 'person',
    ...splitPersonName(name),
  });
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
  const hbr: DisplayAuthor = {
    id: 'harvard business review',
    name: 'Harvard Business Review',
    kind: 'entity',
  };
  const p = (name: string): DisplayAuthor => ({
    id: authorIdFor(name),
    name,
    kind: 'person',
    ...splitPersonName(name),
  });
  assert.equal(
    formatAuthors([hbr, p('Clayton Christensen')]),
    'Harvard Business Review & Christensen',
  );
  assert.equal(
    formatAuthors([hbr, p('Clayton Christensen'), p('Michael Porter')]),
    'Harvard Business Review et al.',
  );
});
