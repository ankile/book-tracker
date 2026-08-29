import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  catalogAuthorsEqual,
  catalogAuthorsOverlap,
  catalogTitleKeys,
  catalogTitleSimilarity,
  matchCatalogText,
  normalizeCatalogAuthorName,
  normalizeCatalogAuthorNames,
  normalizeCatalogTitle,
} from '../src/lib/utils/catalog.ts';

const normalizationFixtures = JSON.parse(readFileSync(fileURLToPath(
  new URL('../test-fixtures/catalog-normalization.json', import.meta.url),
), 'utf8')) as {input: string; output: string}[];

test('title normalization agrees with the shared app/functions fixture', () => {
  for (const fixture of normalizationFixtures) {
    assert.equal(normalizeCatalogTitle(fixture.input), fixture.output, fixture.input);
  }
});

test('title normalization is stable across punctuation, articles, whitespace, and accents', () => {
  const expected = 'hitchhikers guide to the galaxy';
  assert.equal(normalizeCatalogTitle("The Hitchhiker's Guide to the Galaxy"), expected);
  assert.equal(normalizeCatalogTitle('  hitchhikers   guide-to-the galaxy  '), expected);
  assert.equal(normalizeCatalogTitle("Hitchhiker's Guide to the Galaxy, The"), expected);
  assert.equal(normalizeCatalogTitle('Cien años de soledad'), 'cien anos de soledad');
  assert.equal(normalizeCatalogTitle('Søsterklokkene'), 'sosterklokkene');
  assert.equal(normalizeCatalogTitle('The'), 'the');
});

test('title keys normalize aliases, remove duplicates, and omit empty values', () => {
  assert.deepEqual(
    catalogTitleKeys('The Unbearable Lightness of Being', [
      'Unbearable Lightness of Being',
      'Tilværelsens uutholdelige letthet',
      ' ',
    ]),
    ['unbearable lightness of being', 'tilvaerelsens uutholdelige letthet'],
  );
});

test('author normalization folds display differences without treating typos as equal', () => {
  assert.equal(normalizeCatalogAuthorName('Gabriel García Márquez'), 'gabriel garcia marquez');
  assert.equal(normalizeCatalogAuthorName('HarperCollins & Co.'), 'harpercollins and co');
  assert.deepEqual(
    normalizeCatalogAuthorNames([' Zadie Smith ', 'zadie smith', 'Søren Kierkegaard']),
    ['soren kierkegaard', 'zadie smith'],
  );
  assert.equal(catalogAuthorsEqual(['Milan Kundera'], ['milan kundera']), true);
  assert.equal(catalogAuthorsEqual(['Milan Kundera'], ['Milan Kunder']), false);
});

test('author matching distinguishes an exact set from partial overlap', () => {
  assert.equal(
    catalogAuthorsEqual(['Terry Pratchett', 'Neil Gaiman'], ['Neil Gaiman', 'Terry Pratchett']),
    true,
  );
  assert.equal(catalogAuthorsEqual(['Neil Gaiman'], ['Neil Gaiman', 'Terry Pratchett']), false);
  assert.equal(catalogAuthorsOverlap(['Neil Gaiman'], ['Neil Gaiman', 'Terry Pratchett']), true);
  assert.equal(catalogAuthorsOverlap([], ['Neil Gaiman']), false);
});

test('text matching uses explicit aliases and never upgrades a different author', () => {
  const candidate = {
    canonicalTitle: 'The Unbearable Lightness of Being',
    alternateTitles: ['Tilværelsens uutholdelige letthet'],
    authorNames: ['Milan Kundera'],
  };
  assert.equal(
    matchCatalogText('Tilværelsens uutholdelige letthet', ['Milan Kundera'], candidate),
    'title-author-exact',
  );
  assert.equal(
    matchCatalogText('The Unbearable Lightness of Being', ['Another Author'], candidate),
    'title-only',
  );
  assert.equal(matchCatalogText('A different book', ['Milan Kundera'], candidate), 'none');
});

test('partial coauthor evidence remains distinct from an exact author match', () => {
  const candidate = {
    canonicalTitle: 'Good Omens',
    authorNames: ['Neil Gaiman', 'Terry Pratchett'],
  };
  assert.equal(matchCatalogText('Good Omens', ['Neil Gaiman'], candidate), 'title-author-overlap');
  assert.equal(
    matchCatalogText('Good Omens', ['Terry Pratchett', 'Neil Gaiman'], candidate),
    'title-author-exact',
  );
});

test('fuzzy title similarity is deterministic and never supplies identity on its own', () => {
  assert.equal(catalogTitleSimilarity('The Great Gatsby', 'Great Gatsby'), 1);
  assert.equal(catalogTitleSimilarity('', ''), 0);
  const typoScore = catalogTitleSimilarity('The Hitchhikers Guide', 'The Hitchikers Guide');
  assert.ok(typoScore > 0.9 && typoScore < 1);
  assert.ok(catalogTitleSimilarity('Gul bok', 'Blue Ocean Strategy') < 0.3);
});
