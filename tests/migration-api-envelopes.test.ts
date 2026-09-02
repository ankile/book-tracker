import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bookLookupCache,
  googleBooksVolume,
  nbSearchItem,
  openLibraryRecord,
} from '../migration-api-envelopes.ts';

const cachedLookup = {
  title: 'Circe',
  authorNames: ['Madeline Miller'],
  coverUrl: 'https://example.com/circe.jpg',
  publisher: 'Little, Brown',
  publishedDate: '2018',
  subjects: ['Fiction'],
  fiction: true,
  language: '',
};

test('lookup cache decodes nullable results and omitted optional page counts', () => {
  assert.deepEqual(bookLookupCache({}), {});
  assert.deepEqual(bookLookupCache({
    '9780316556347': cachedLookup,
    '9780000000002': null,
  }), {
    '9780316556347': {...cachedLookup, pageCount: undefined},
    '9780000000002': null,
  });
  assert.equal(
    bookLookupCache({'9780316556347': {...cachedLookup, pageCount: 400}})
      ['9780316556347']?.pageCount,
    400,
  );
  assert.equal(
    bookLookupCache({'9780316556347': {...cachedLookup, fiction: null}})
      ['9780316556347']?.fiction,
    null,
  );
});

test('lookup cache rejects malformed roots, keys, values, and nested fields', () => {
  for (const field of [
    'title', 'authorNames', 'coverUrl', 'publisher', 'publishedDate',
    'subjects', 'fiction',
  ]) {
    const missing: Record<string, unknown> = {...cachedLookup};
    delete missing[field];
    assert.throws(() => bookLookupCache({'9780316556347': missing}));
  }

  for (const cache of [
    null,
    [],
    {'not-an-isbn': cachedLookup},
    {'9780000000000': cachedLookup},
    {'0316556343': cachedLookup},
    {'9780316556347': []},
    {'9780316556347': {...cachedLookup, title: 42}},
    {'9780316556347': {...cachedLookup, authorNames: 'Madeline Miller'}},
    {'9780316556347': {...cachedLookup, authorNames: ['Madeline Miller', 42]}},
    {'9780316556347': {...cachedLookup, coverUrl: null}},
    {'9780316556347': {...cachedLookup, publisher: 42}},
    {'9780316556347': {...cachedLookup, publishedDate: false}},
    {'9780316556347': {...cachedLookup, subjects: 'Fiction'}},
    {'9780316556347': {...cachedLookup, subjects: ['Fiction', 42]}},
    {'9780316556347': {...cachedLookup, pageCount: null}},
    {'9780316556347': {...cachedLookup, pageCount: -1}},
    {'9780316556347': {...cachedLookup, pageCount: 1.5}},
    {'9780316556347': {...cachedLookup, pageCount: Number.MAX_SAFE_INTEGER + 1}},
    {'9780316556347': {...cachedLookup, fiction: 'yes'}},
    {'9780316556347': {...cachedLookup, secret: true}},
  ]) {
    assert.throws(() => bookLookupCache(cache));
  }
});

test('Open Library selects the requested record from an object envelope', () => {
  const record = { title: 'Circe' };
  assert.equal(
    openLibraryRecord({ 'ISBN:9780316556347': record }, '9780316556347'),
    record,
  );
  assert.equal(openLibraryRecord({}, '9780316556347'), undefined);
});

test('Open Library rejects non-object envelopes', () => {
  for (const payload of [null, [], 'not json data']) {
    assert.throws(
      () => openLibraryRecord(payload, '9780316556347'),
      /Open Library response must be an object/,
    );
  }
});

test('Google Books selects volumeInfo and represents an absent result', () => {
  const volume = { title: 'Circe' };
  assert.equal(googleBooksVolume({ items: [{ volumeInfo: volume }] }), volume);
  assert.equal(googleBooksVolume({ totalItems: 0 }), undefined);
  assert.equal(googleBooksVolume({ items: [] }), undefined);
});

test('Google Books rejects malformed envelope layers', () => {
  for (const payload of [null, [], { items: {} }, { items: [null] }]) {
    assert.throws(() => googleBooksVolume(payload));
  }
  assert.throws(
    () => googleBooksVolume({ items: [{}] }),
    /missing volumeInfo/,
  );
});

test('Nasjonalbiblioteket selects an identified item and represents an absent result', () => {
  const item = { id: 'da0b9c16', metadata: { title: 'Sult' } };
  assert.deepEqual(
    nbSearchItem({ _embedded: { items: [item] } }),
    { id: 'da0b9c16', record: item },
  );
  assert.equal(nbSearchItem({}), undefined);
  assert.equal(nbSearchItem({ _embedded: { items: [] } }), undefined);
});

test('Nasjonalbiblioteket rejects malformed envelope layers and ids', () => {
  for (const payload of [
    null,
    [],
    { _embedded: [] },
    { _embedded: { items: {} } },
    { _embedded: { items: [null] } },
    { _embedded: { items: [{}] } },
    { _embedded: { items: [{ id: 42 }] } },
  ]) {
    assert.throws(() => nbSearchItem(payload));
  }
});
