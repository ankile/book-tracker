import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deterministicCatalogId,
  deterministicTitleIndexId,
  planCrossUserCatalog,
  resolveMigrationAuthors,
  type MigrationAuthor,
  type MigrationBook,
} from '../cross-user-work-migration.ts'

const author = (id: string, name: string): MigrationAuthor => ({ id, name, kind: 'person', retirement: null })
const book = (path: string, overrides: Partial<MigrationBook> = {}): MigrationBook => ({
  path,
  uid: path.split('/')[1],
  bookId: path.split('/')[3],
  title: 'The Left Hand of Darkness',
  isbn: '9780441478125',
  authorIds: ['ursula'],
  eligibleSeed: true,
  seedPriority: 1,
  ...overrides,
})

test('catalog ids are deterministic and namespace their inputs', () => {
  assert.equal(deterministicCatalogId('work', 'same'), deterministicCatalogId('work', 'same'))
  assert.notEqual(deterministicCatalogId('work', 'same'), deterministicCatalogId('edition', 'same'))
  assert.match(deterministicCatalogId('work', 'same'), /^work_[0-9a-f]{24}$/)
  assert.match(deterministicTitleIndexId('work-a', 'title'), /^[0-9a-f]{64}$/)
  assert.notEqual(deterministicTitleIndexId('work-a', 'title'), deterministicTitleIndexId('work-b', 'title'))
})

test('ISBN-first grouping links punctuation variants and preserves one suggested edition', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one'),
    book('users/b/books/two', { title: 'Left Hand of Darkness, The', pageCount: 304, eligibleSeed: false }),
  ], authors)

  assert.equal(plan.ambiguities.length, 0)
  assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].isbns, ['9780441478125'])
  assert.deepEqual(plan.groups[0].seedIsbns, ['9780441478125'])
  assert.equal(plan.groups[0].candidates.length, 2)
  assert.equal(plan.groups[0].editionIds['9780441478125'], deterministicCatalogId('edition', `${plan.groups[0].workId}\0${'9780441478125'}`))
})

test('private copies can join a work but cannot contribute shared titles or editions', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/shared', {isbn: '', title: 'The Left Hand of Darkness'}),
    book('users/b/books/private', {
      eligibleSeed: false,
      seedPriority: 2,
      isbn: '9780441478125',
      title: 'Private shelf label',
    }),
  ], authors, [{
    id: 'reviewed-private-link',
    bookPaths: ['users/a/books/shared', 'users/b/books/private'],
    canonicalTitle: 'The Left Hand of Darkness',
    authorNames: ['Ursula K. Le Guin'],
  }])

  assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].isbns, ['9780441478125'])
  assert.deepEqual(plan.groups[0].seedIsbns, [])
  assert.deepEqual(plan.groups[0].alternateTitles, [])
})

test('same title and author groups editions while different authors remain separate', () => {
  const authors = new Map([
    ['ursula', author('ursula', 'Ursula K. Le Guin')],
    ['other', author('other', 'Someone Else')],
  ])
  const plan = planCrossUserCatalog([
    book('users/a/books/one'),
    book('users/b/books/two', { isbn: '9781473217386' }),
    book('users/c/books/three', { isbn: '', authorIds: ['other'] }),
  ], authors)

  assert.equal(plan.groups.length, 2)
  assert.deepEqual(plan.groups.map((group) => group.candidates.length).sort(), [1, 2])
  assert.equal(plan.ambiguities.length, 0)
})

test('conflicting identities under one ISBN are reported and never grouped', () => {
  const authors = new Map([
    ['ursula', author('ursula', 'Ursula K. Le Guin')],
    ['other', author('other', 'Someone Else')],
  ])
  const plan = planCrossUserCatalog([
    book('users/a/books/one'),
    book('users/b/books/two', { title: 'A Different Book', authorIds: ['other'] }),
  ], authors)

  assert.equal(plan.groups.length, 0)
  assert.equal(plan.ambiguities.filter((item) => item.type === 'isbn-conflict').length, 1)
})

test('reviewed exact paths can join translations and author spellings without fuzzy matching', () => {
  const authors = new Map([
    ['kundera', author('kundera', 'Milan Kundera')],
    ['misspelled', author('misspelled', 'Milan Kundra')],
  ])
  const paths = ['users/a/books/one', 'users/b/books/two']
  const plan = planCrossUserCatalog([
    book(paths[0], { title: 'The Unbearable Lightness of Being', isbn: '', authorIds: ['kundera'] }),
    book(paths[1], { title: 'Tilværelsens uutholdelige letthet', isbn: '', authorIds: ['misspelled'] }),
  ], authors, [{
    id: 'unbearable-lightness-reviewed',
    bookPaths: paths,
    canonicalTitle: 'The Unbearable Lightness of Being',
    alternateTitles: ['Tilværelsens uutholdelige letthet'],
    authorNames: ['Milan Kundera'],
  }])

  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].reviewedGroupId, 'unbearable-lightness-reviewed')
  assert.deepEqual(plan.groups[0].authorNames, ['Milan Kundera'])
  assert.deepEqual(plan.groups[0].alternateTitles, ['Tilværelsens uutholdelige letthet'])
})

test('placeholder and deleted authors never become catalog identity', () => {
  const authors = new Map<string, MigrationAuthor>([
    ['placeholder', { id: 'placeholder', name: 'Various Authors', kind: 'placeholder', retirement: null }],
    ['deleted', { id: 'deleted', name: 'Old Name', kind: 'person', retirement: { reason: 'deleted' } }],
  ])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', { authorIds: ['placeholder'] }),
    book('users/b/books/two', { isbn: '9781473217386', authorIds: ['deleted'] }),
  ], authors)

  assert.equal(plan.groups.length, 0)
  assert.equal(plan.ambiguities.filter((item) => item.detail.includes('missing-resolved-author')).length, 2)
})

test('merged personal authors resolve to the canonical non-placeholder author', () => {
  const authors = new Map<string, MigrationAuthor>([
    ['old', { id: 'old', name: 'U. Le Guin', kind: 'person', retirement: { reason: 'merged', targetId: 'ursula' } }],
    ['ursula', author('ursula', 'Ursula K. Le Guin')],
  ])
  assert.deepEqual(resolveMigrationAuthors(book('users/a/books/one', { authorIds: ['old'] }), authors), {
    names: ['Ursula K. Le Guin'],
    problems: [],
  })
})

test('private-only groups are identified but cannot seed catalog documents', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', { eligibleSeed: false, seedPriority: 2 }),
  ], authors)

  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].eligibleSeed, false)
})

test('an invalid reviewed manifest assignment remains a review finding', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one'),
  ], authors, [{
    id: 'missing-path',
    bookPaths: ['users/missing/books/nope'],
    canonicalTitle: 'Nope',
    authorNames: ['Nobody'],
  }])

  assert.equal(plan.ambiguities[0].type, 'invalid-reviewed-group')
})
