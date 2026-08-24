import assert from 'node:assert/strict';
import test from 'node:test';

import {
  googleBooksVolume,
  nbSearchItem,
  openLibraryRecord,
} from '../migration-api-envelopes.ts';

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
