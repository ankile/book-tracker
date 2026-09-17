import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorChip } from '../src/lib/interfaces/author.ts';
import { completeBookDraft, type BookDraft, type BookDraftServices } from '../src/lib/utils/bookDraft.ts';
import { EMPTY_METADATA } from '../src/lib/utils/bookMetadata.ts';

const existing: AuthorChip = { id: 'author-le-guin', name: 'Ursula K. Le Guin' };
const fresh: AuthorChip = { id: null, name: 'New Author', kind: 'person', givenName: 'New', familyName: 'Author' };

const draft = (overrides: Partial<BookDraft> = {}): BookDraft => ({
  online: true,
  authorChips: [existing],
  catalogSelection: null,
  selectedWorkLanguage: '',
  catalogChoiceTouched: false,
  title: 'The Dispossessed',
  isbn: '9780061054884',
  pageCount: 387,
  metadata: { ...EMPTY_METADATA, language: 'en' },
  ...overrides,
});

// Records every call so a test can assert which steps ran and with what.
function services(overrides: Partial<BookDraftServices> = {}) {
  const calls: string[] = [];
  const impl: BookDraftServices = {
    resolveAuthors: async (chips) => {
      calls.push('resolveAuthors');
      return chips.map((chip) => (chip.id === null ? { id: `minted-${chip.name}`, name: chip.name } : chip));
    },
    addEdition: async (request) => {
      calls.push(`addEdition:${request.workId}:${request.edition.suggestedPageCount}:${request.edition.language}`);
      return { workId: request.workId, editionId: 'new-edition', created: true };
    },
    createWork: async (request) => {
      calls.push(`createWork:${request.work.authorIds.join(',')}`);
      return { workId: 'new-work', editionId: 'new-work-edition', created: true };
    },
    cancelled: () => false,
    ...overrides,
  };
  return { calls, impl };
}

test('an unmatched book with resolved authors seeds a shared work and links to it', async () => {
  const { calls, impl } = services();
  const phases: (string | null)[] = [];
  const result = await completeBookDraft(draft(), impl, (phase) => phases.push(phase));
  assert.deepEqual(result, {
    ok: true,
    authorChips: [existing],
    catalogSelection: { workId: 'new-work', editionId: 'new-work-edition', matchMethod: 'catalog-choice' },
    catalogChoiceTouched: true,
  });
  assert.deepEqual(calls, ['createWork:author-le-guin']);
  assert.deepEqual(phases, ['catalog', null]);
});

test('new authors are minted first and their ids seed the work', async () => {
  const { calls, impl } = services();
  const phases: (string | null)[] = [];
  const result = await completeBookDraft(draft({ authorChips: [fresh] }), impl, (phase) => phases.push(phase));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.authorChips, [{ id: 'minted-New Author', name: 'New Author' }]);
  assert.deepEqual(calls, ['resolveAuthors', 'createWork:minted-New Author']);
  assert.deepEqual(phases, ['authors', 'catalog', null]);
});

test('a chosen work without an edition gets this book\'s edition, with the language override', async () => {
  const { calls, impl } = services();
  const result = await completeBookDraft(draft({
    catalogSelection: { workId: 'work', editionId: null, matchMethod: 'catalog-choice' },
    selectedWorkLanguage: 'no',
  }), impl);
  assert.deepEqual(result, {
    ok: true,
    authorChips: [existing],
    catalogSelection: { workId: 'work', editionId: 'new-edition', matchMethod: 'catalog-choice' },
    catalogChoiceTouched: true,
  });
  assert.deepEqual(calls, ['addEdition:work:387:en']);
});

test('offline, new authors and missing editions block; an unmatched book just stays unlinked', async () => {
  const { calls, impl } = services();
  assert.deepEqual(await completeBookDraft(draft({ online: false, authorChips: [fresh] }), impl), {
    ok: false, message: 'Connect to create a new shared author, then try again.',
  });
  assert.deepEqual(await completeBookDraft(draft({
    online: false,
    catalogSelection: { workId: 'work', editionId: null, matchMethod: 'catalog-choice' },
  }), impl), { ok: false, message: 'Connect to add your edition to the shared work, then try again.' });
  const unlinked = await completeBookDraft(draft({ online: false }), impl);
  assert.deepEqual(unlinked, { ok: true, authorChips: [existing], catalogSelection: null, catalogChoiceTouched: false });
  assert.deepEqual(calls, []);
});

test('an explicit unlinked choice, a linked edition, or no authors seed nothing', async () => {
  const { calls, impl } = services();
  await completeBookDraft(draft({ catalogChoiceTouched: true }), impl);
  await completeBookDraft(draft({ catalogSelection: { workId: 'work', editionId: 'edition', matchMethod: 'isbn' } }), impl);
  await completeBookDraft(draft({ authorChips: [] }), impl);
  assert.deepEqual(calls, []);
});

test('a planned book without a page count settles its authors only', async () => {
  const { calls, impl } = services();
  const result = await completeBookDraft(draft({
    pageCount: null,
    authorChips: [fresh],
    catalogSelection: { workId: 'work', editionId: null, matchMethod: 'catalog-choice' },
  }), impl);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.catalogSelection, { workId: 'work', editionId: null, matchMethod: 'catalog-choice' });
  assert.equal(result.catalogChoiceTouched, false);
  assert.deepEqual(calls, ['resolveAuthors']);
});

test('service failures keep the draft with a step-specific message and end the phase', async () => {
  const phases: (string | null)[] = [];
  const failing = services({ resolveAuthors: async () => { throw new Error('Author quota reached.'); } });
  assert.deepEqual(await completeBookDraft(draft({ authorChips: [fresh] }), failing.impl, (phase) => phases.push(phase)), {
    ok: false, message: 'Author quota reached.',
  });
  assert.deepEqual(phases, ['authors', null]);
  const noEdition = services({ addEdition: async () => { throw new Error('boom'); } });
  const edition = await completeBookDraft(draft({
    catalogSelection: { workId: 'work', editionId: null, matchMethod: 'catalog-choice' },
  }), noEdition.impl);
  assert.equal(edition.ok, false);
  if (edition.ok) throw new Error('unreachable');
  assert.match(edition.message, /Could not add your edition/);
  const noWork = services({ createWork: async () => { throw new Error('boom'); } });
  const work = await completeBookDraft(draft(), noWork.impl);
  assert.equal(work.ok, false);
  if (work.ok) throw new Error('unreachable');
  assert.match(work.message, /Could not create the shared work/);
});

test('a draft abandoned during a network step writes nothing further to the catalog', async () => {
  // Closed while the author is being minted: no work is seeded.
  let closed = false;
  const duringAuthors = services({ cancelled: () => closed });
  const resolveAuthors = duringAuthors.impl.resolveAuthors;
  duringAuthors.impl.resolveAuthors = async (chips) => {
    closed = true;
    return resolveAuthors(chips);
  };
  const first = await completeBookDraft(draft({ authorChips: [fresh] }), duringAuthors.impl);
  assert.equal(first.ok, false);
  assert.deepEqual(duringAuthors.calls, ['resolveAuthors']);
  // Still open: the same draft goes on to seed the work.
  const open = services();
  await completeBookDraft(draft({ authorChips: [fresh] }), open.impl);
  assert.deepEqual(open.calls, ['resolveAuthors', 'createWork:minted-New Author']);
});
