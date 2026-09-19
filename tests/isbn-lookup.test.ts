import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupIsbnSources, primaryLookup } from '../src/lib/utils/isbnLookup.ts';
import { selectLookupMetadata } from '../src/lib/utils/bookMetadata.ts';

const ISBN = '9788205394810';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});

// One fake network: Open Library's data API, the national library's search
// and MODS endpoints, and the Google callable as a function.
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    return route[1]();
  }) as typeof fetch;
}

test('every source answers and the fields take their documented precedence', async () => {
  const sources = await lookupIsbnSources(ISBN, {
    fetch: fakeFetch({
      'https://openlibrary.org/api/books': () => jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Sult', authors: [{name: 'Knut Hamsun'}], number_of_pages: 198,
          publishers: [{name: 'Gyldendal'}], publish_date: '2009',
          subjects: [{name: 'Norwegian fiction'}], cover: {medium: 'https://covers.openlibrary.org/b/id/1-M.jpg'},
        },
      }),
      'https://api.nb.no/catalog/v1/items': () => jsonResponse({
        _embedded: {items: [{id: 'nb-1', metadata: {title: 'Sult', creators: ['Hamsun, Knut'], pageCount: 199,
          originInfo: {publisher: 'Gyldendal Norsk Forlag', issued: '2009'}}}]},
      }),
      'https://api.nb.no/catalog/v1/metadata/nb-1/mods': () => new Response(
        '<mods:mods><mods:genre>Romaner</mods:genre><mods:language><mods:languageTerm type="code">nob</mods:languageTerm></mods:language></mods:mods>',
        {status: 200},
      ),
    }),
    google: async () => ({volume: {
      title: 'Sult', authors: ['Knut Hamsun'], pageCount: 200, categories: ['Fiction'],
      imageLinks: {thumbnail: 'http://books.google.com/sult.jpg'}, language: 'no',
    }}),
  });
  const primary = primaryLookup(sources);
  assert.equal(primary?.title, 'Sult');
  assert.equal(primary?.pageCount, 198);
  assert.deepEqual(primary?.authorNames, ['Knut Hamsun']);
  assert.deepEqual(selectLookupMetadata(sources.openLibrary, sources.google, sources.nb), {
    coverUrl: 'https://books.google.com/sult.jpg',
    publisher: 'Gyldendal',
    publishedDate: '2009',
    subjects: ['Norwegian fiction'],
    fiction: true,
    language: 'no',
  });
});

test('sources that fail or know nothing answer null, and none at all is no primary', async () => {
  const sources = await lookupIsbnSources(ISBN, {
    fetch: fakeFetch({
      'https://openlibrary.org/api/books': () => jsonResponse({}),
      'https://api.nb.no/catalog/v1/items': () => new Response('', {status: 500}),
    }),
    google: async () => { throw new Error('quota'); },
  });
  assert.deepEqual(sources, {openLibrary: null, google: null, nb: null});
  assert.equal(primaryLookup(sources), null);
});

// Open Library is the first source asked and the one that answered every
// ISBN with an empty 404 on 2026-09-18. Its outage must cost its own
// fields only: the other two sources still answer and the lookup still
// has a primary.
test('an Open Library outage costs its fields, not the other sources', async () => {
  const sources = await lookupIsbnSources(ISBN, {
    fetch: fakeFetch({
      'https://openlibrary.org/api/books': () => new Response('', {status: 404}),
      'https://api.nb.no/catalog/v1/items': () => jsonResponse({
        _embedded: {items: [{id: 'nb-1', metadata: {title: 'Sult', creators: ['Hamsun, Knut'], pageCount: 199,
          originInfo: {publisher: 'Gyldendal Norsk Forlag', issued: '2009'}}}]},
      }),
      'https://api.nb.no/catalog/v1/metadata/nb-1/mods': () => new Response('<mods:mods/>', {status: 200}),
    }),
    google: async () => ({volume: {title: 'Sult', authors: ['Knut Hamsun'], pageCount: 200}}),
  });
  assert.equal(sources.openLibrary, null);
  assert.equal(sources.google?.title, 'Sult');
  assert.equal(sources.nb?.publisher, 'Gyldendal Norsk Forlag');
  assert.equal(primaryLookup(sources)?.pageCount, 200);
});

// A 200 with a body the parser rejects is the same outage in a different
// coat: it must not abort the lookup either.
test('an unparseable Open Library answer counts as knowing nothing', async () => {
  const sources = await lookupIsbnSources(ISBN, {
    fetch: fakeFetch({
      'https://openlibrary.org/api/books': () => jsonResponse([]),
      'https://api.nb.no/catalog/v1/items': () => jsonResponse({_embedded: {items: []}}),
    }),
    google: async () => ({volume: {title: 'Sult', authors: ['Knut Hamsun']}}),
  });
  assert.equal(sources.openLibrary, null);
  assert.equal(sources.google?.title, 'Sult');
});
