import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  catalogTitleKeys,
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
  assert.notEqual(normalizeCatalogAuthorName('Milan Kundera'), normalizeCatalogAuthorName('Milan Kunder'));
});
