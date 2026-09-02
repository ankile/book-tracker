import assert from 'node:assert/strict';
import test from 'node:test';
import { planWorkLanguages, type LanguageBook } from '../work-language-backfill.ts';

type Doc = Record<string, unknown>;

const work = (overrides: Doc = {}): Doc => ({status: 'active', mergedFrom: [], ...overrides});
const edition = (workId: string, overrides: Doc = {}): Doc => ({workId, isbn13: null, language: '', ...overrides});
const book = (uid: string, bookId: string, data: Doc): LanguageBook => ({uid, bookId, data});

test('a work without the field takes the one language its editions agree on, else is listed', () => {
  const plan = planWorkLanguages({
    works: new Map([
      ['sult', work()],
      ['left-hand', work()],
      ['translated', work()],
      ['original-and-translation', work()],
      ['split', work()],
      ['bare', work()],
      ['unknown-group', work()],
      ['stamped', work({language: 'de'})],
      ['stamped-empty', work({language: ''})],
      ['hidden', work({status: 'hidden'})],
      ['alias', work({status: 'merged', mergedInto: 'sult'})],
    ]),
    editions: new Map([
      ['sult-gyldendal', edition('sult', {isbn13: '9788205394810'})],
      // An alias's ISBN does not count; a merged edition is not one of the work's.
      ['sult-old', edition('sult', {isbn13: '9780000000000', status: 'merged', mergedInto: 'sult-gyldendal'})],
      ['left-hand-ace', edition('left-hand', {isbn13: '9780441478125'})],
      ['left-hand-uk', edition('left-hand', {isbn13: '9781000000000'})],
      // Overrides that agree decide, ISBN or not.
      ['translated-en', edition('translated', {isbn13: '9788200000000', language: 'en'})],
      ['translated-more', edition('translated', {language: 'en'})],
      // An override beside an ISBN that says otherwise is the operator's call.
      ['original-no', edition('original-and-translation', {isbn13: '9788205394810'})],
      ['translation-en', edition('original-and-translation', {isbn13: '9780000000001', language: 'en'})],
      // Overrides that disagree answer nothing.
      ['split-en', edition('split', {language: 'en'})],
      ['split-no', edition('split', {language: 'no'})],
      ['unknown-group-edition', edition('unknown-group', {isbn13: '9789200000000'})],
    ]),
    books: [],
  });
  assert.deepEqual(plan.works, [
    {id: 'alias', language: '', source: 'none'},
    {id: 'bare', language: '', source: 'none'},
    {id: 'hidden', language: '', source: 'none'},
    {id: 'left-hand', language: 'en', source: 'isbn-group'},
    {id: 'original-and-translation', language: '', source: 'none'},
    {id: 'split', language: '', source: 'none'},
    {id: 'sult', language: 'no', source: 'isbn-group'},
    {id: 'translated', language: 'en', source: 'editions'},
    {id: 'unknown-group', language: '', source: 'none'},
  ]);
  // Only live works ask the operator; the alias redirects and hidden is out.
  assert.deepEqual(plan.review, [
    {id: 'bare', reason: 'no ISBN'},
    {id: 'original-and-translation', reason: 'evidence disagrees (en, no)'},
    {id: 'split', reason: 'evidence disagrees (en, no)'},
    {id: 'unknown-group', reason: 'ISBN group unknown'},
  ]);
});

test('editions whose ISBN groups disagree are listed rather than guessed', () => {
  const plan = planWorkLanguages({
    works: new Map([['mixed', work()]]),
    editions: new Map([
      ['mixed-en', edition('mixed', {isbn13: '9780441478125'})],
      ['mixed-no', edition('mixed', {isbn13: '9788205394810'})],
    ]),
    books: [],
  });
  assert.deepEqual(plan.works, [{id: 'mixed', language: '', source: 'none'}]);
  assert.deepEqual(plan.review, [{id: 'mixed', reason: 'evidence disagrees (en, no)'}]);
});

test('books carry the effective language of the edition they stand on, resolved through aliases', () => {
  const plan = planWorkLanguages({
    works: new Map([
      ['sult', work({language: 'no'})],
      ['old-sult', work({status: 'merged', mergedInto: 'sult'})],
      ['stamped', work({language: 'de'})],
    ]),
    editions: new Map([
      ['sult-gyldendal', edition('sult', {isbn13: '9788205394810'})],
      ['sult-english', edition('sult', {language: 'en'})],
      ['sult-bare', edition('sult', {status: 'merged', mergedInto: 'sult-english'})],
      ['stamped-edition', edition('stamped')],
    ]),
    books: [
      // Inherits the work's default.
      book('lars', 'sult', {workId: 'sult', editionId: 'sult-gyldendal'}),
      // The edition's override wins.
      book('lars', 'sult-en', {workId: 'sult', editionId: 'sult-english'}),
      // A merged edition and a merged work resolve one hop.
      book('magnus', 'sult', {workId: 'old-sult', editionId: 'sult-bare'}),
      // A stamped work's default carries.
      book('magnus', 'faust', {workId: 'stamped', editionId: 'stamped-edition'}),
      // A book linked to a work with no edition takes the work's default.
      book('magnus', 'editionless', {workId: 'sult', editionId: null}),
      // Unlinked: the field exists, empty.
      book('lars', 'loose', {workId: null, editionId: null}),
      // Already carried: left alone, whatever it says.
      book('lars', 'own', {workId: 'sult', editionId: 'sult-gyldendal', language: 'nn'}),
      // Carries '' where a language is now known: filled.
      book('lars', 'blank', {workId: 'sult', editionId: 'sult-gyldendal', language: ''}),
      // Carries '' and nothing better is known: left alone (a rerun plans nothing).
      book('lars', 'blank-loose', {workId: null, editionId: null, language: ''}),
    ],
  });
  assert.deepEqual(plan.books, [
    {uid: 'lars', bookId: 'blank', language: 'no'},
    {uid: 'lars', bookId: 'loose', language: ''},
    {uid: 'lars', bookId: 'sult', language: 'no'},
    {uid: 'lars', bookId: 'sult-en', language: 'en'},
    {uid: 'magnus', bookId: 'editionless', language: 'no'},
    {uid: 'magnus', bookId: 'faust', language: 'de'},
    {uid: 'magnus', bookId: 'sult', language: 'en'},
  ]);
});

test('a second run plans nothing', () => {
  const works = new Map([['sult', work({language: 'no'})], ['bare', work({language: ''})]]);
  const editions = new Map([['sult-gyldendal', edition('sult')]]);
  const plan = planWorkLanguages({
    works,
    editions,
    books: [
      book('lars', 'sult', {workId: 'sult', editionId: 'sult-gyldendal', language: 'no'}),
      book('lars', 'bare', {workId: 'bare', editionId: null, language: ''}),
      book('lars', 'loose', {workId: null, editionId: null, language: ''}),
    ],
  });
  assert.deepEqual(plan, {works: [], books: [], review: []});
});

test('a stored language that is not a string is a crash, not a guess', () => {
  assert.throws(() => planWorkLanguages({
    works: new Map([['sult', work({language: 7})]]),
    editions: new Map(),
    books: [],
  }), /works\/sult\.language must be a string/);
  assert.throws(() => planWorkLanguages({
    works: new Map([['sult', work({language: 'no'})]]),
    editions: new Map(),
    books: [book('lars', 'sult', {workId: 'sult', editionId: null, language: ['no']})],
  }), /users\/lars\/books\/sult\.language must be a string/);
});
