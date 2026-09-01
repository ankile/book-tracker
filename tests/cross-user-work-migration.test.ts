import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  deterministicCatalogId,
  deterministicExternalIndexId,
  deterministicSharedWorkOwnerId,
  deterministicTitleIndexId,
  planCrossUserCatalog,
  resolveMigrationAuthors,
  type MigrationAuthor,
  type MigrationBook,
  type ReviewedWorkGroup,
} from '../cross-user-work-migration.ts'

const author = (id: string, name: string): MigrationAuthor => ({ id, name, kind: 'person', retirement: null })
const book = (path: string, overrides: Partial<MigrationBook> = {}): MigrationBook => ({
  path,
  uid: path.split('/')[1],
  title: 'The Left Hand of Darkness',
  isbn: '9780441478125',
  authorIds: ['ursula'],
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
    book('users/b/books/two', { title: 'Left Hand of Darkness, The', pageCount: 304 }),
  ], authors)

  assert.equal(plan.ambiguities.length, 0)
  assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].isbns, ['9780441478125'])
  assert.equal(plan.groups[0].candidates.length, 2)
  assert.equal(plan.groups[0].editionIds['9780441478125'], deterministicCatalogId('edition', `${plan.groups[0].workId}\0${'9780441478125'}`))
})

test('every copy contributes its edition; a reviewed group still pins the canonical title', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/shared', {isbn: '', title: 'The Left Hand of Darkness'}),
    book('users/b/books/second', {
      isbn: '9780441478125',
      title: 'Second shelf label',
    }),
  ], authors, [{
    id: 'reviewed-second-link',
    bookPaths: ['users/a/books/shared', 'users/b/books/second'],
    canonicalTitle: 'The Left Hand of Darkness',
    authorNames: ['Ursula K. Le Guin'],
    authorKinds: ['person'],
  }])

  assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].isbns, ['9780441478125'])
  assert.equal(plan.groups[0].canonicalTitle, 'The Left Hand of Darkness')
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
    authorKinds: ['person'],
  }])

  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].reviewedGroupId, 'unbearable-lightness-reviewed')
  assert.deepEqual(plan.groups[0].authorNames, ['Milan Kundera'])
  assert.deepEqual(plan.groups[0].alternateTitles, ['Tilværelsens uutholdelige letthet'])
})

test('a reviewed spelling correction can introduce the canonical shared author', () => {
  const authors = new Map([
    ['misspelled', author('misspelled', 'Milan Kundra')],
  ])
  const path = 'users/a/books/one'
  const plan = planCrossUserCatalog([
    book(path, {title: 'The Unbearable Lightness of Being', isbn: '', authorIds: ['misspelled']}),
  ], authors, [{
    id: 'corrected-author-reviewed',
    bookPaths: [path],
    canonicalTitle: 'The Unbearable Lightness of Being',
    authorNames: ['Milan Kundera'],
    authorKinds: ['person'],
  }])

  const canonical = plan.authors.find((item) => item.canonicalName === 'Milan Kundera')
  assert.ok(canonical)
  assert.deepEqual(plan.groups[0].authorIds, [canonical.authorId])
  assert.deepEqual(plan.candidates[0].personalAuthorIds, [canonical.authorId])
  assert.equal(plan.authors.some((item) => item.canonicalName === 'Milan Kundra'), false)
})

test('a reviewed canonical name preserves exact entity provenance', () => {
  const authors = new Map<string, MigrationAuthor>([[
    'hbr',
    {id: 'hbr', name: 'Harvard Business Review', kind: 'entity', retirement: null},
  ]])
  const path = 'users/a/books/one'
  const plan = planCrossUserCatalog([
    book(path, {title: 'Management Book', isbn: '', authorIds: ['hbr']}),
  ], authors, [{
    id: 'reviewed-entity',
    bookPaths: [path],
    canonicalTitle: 'Management Book',
    authorNames: ['Harvard Business Review'],
    authorKinds: ['entity'],
  }])

  const canonical = plan.authors.find((item) => item.canonicalName === 'Harvard Business Review')
  assert.ok(canonical)
  assert.equal(canonical.kind, 'entity')
  assert.deepEqual(plan.candidates[0].personalAuthorIds, [canonical.authorId])
})

test('a reviewed entity spelling correction requires and preserves explicit provenance', () => {
  const authors = new Map<string, MigrationAuthor>([[
    'hbr',
    {id: 'hbr', name: 'Harvard Business Revue', kind: 'entity', retirement: null},
  ]])
  const path = 'users/a/books/one'
  const plan = planCrossUserCatalog([
    book(path, {title: 'Management Book', isbn: '', authorIds: ['hbr']}),
  ], authors, [{
    id: 'reviewed-corrected-entity',
    bookPaths: [path],
    canonicalTitle: 'Management Book',
    authorNames: ['Harvard Business Review'],
    authorKinds: ['entity'],
  }])

  const canonical = plan.authors.find((item) => item.canonicalName === 'Harvard Business Review')
  assert.ok(canonical)
  assert.equal(canonical.kind, 'entity')
  assert.deepEqual(plan.candidates[0].personalAuthorIds, [canonical.authorId])
  assert.equal(plan.authors.some((item) => item.canonicalName === 'Harvard Business Revue'), false)
})

test('a reviewed entity spelling correction without kinds is rejected', () => {
  const authors = new Map<string, MigrationAuthor>([[
    'hbr',
    {id: 'hbr', name: 'Harvard Business Revue', kind: 'entity', retirement: null},
  ]])
  const path = 'users/a/books/one'
  const missingKinds = {
    id: 'reviewed-corrected-entity',
    bookPaths: [path],
    canonicalTitle: 'Management Book',
    authorNames: ['Harvard Business Review'],
  } as ReviewedWorkGroup
  const plan = planCrossUserCatalog([
    book(path, {title: 'Management Book', isbn: '', authorIds: ['hbr']}),
  ], authors, [missingKinds])

  assert.equal(plan.ambiguities.some((item) =>
    item.type === 'invalid-reviewed-group' && item.detail.includes('authorKinds')),
  true)
  assert.equal(plan.authors.some((item) => item.canonicalName === 'Harvard Business Review'), false)
  assert.deepEqual(plan.candidates[0].personalAuthorIds, ['hbr'])
})

test('reviewed multi-author kinds stay attached while normalized names are sorted', () => {
  const authors = new Map([['source', author('source', 'Source Author')]])
  const path = 'users/a/books/one'
  const plan = planCrossUserCatalog([
    book(path, {title: 'Mixed Attribution', isbn: '', authorIds: ['source']}),
  ], authors, [{
    id: 'reviewed-mixed-kinds',
    bookPaths: [path],
    canonicalTitle: 'Mixed Attribution',
    authorNames: ['Zed Corporation', 'Alice Person'],
    authorKinds: ['entity', 'person'],
  }])

  assert.deepEqual(plan.groups[0].authorNames, ['Alice Person', 'Zed Corporation'])
  assert.equal(plan.authors.find((item) => item.canonicalName === 'Alice Person')?.kind, 'person')
  assert.equal(plan.authors.find((item) => item.canonicalName === 'Zed Corporation')?.kind, 'entity')
})

test('conflicting reviewed kinds for one normalized author reject the reviewed group', () => {
  const authors = new Map([['source', author('source', 'Source Author')]])
  const path = 'users/a/books/one'
  const plan = planCrossUserCatalog([
    book(path, {title: 'Mixed Attribution', isbn: '', authorIds: ['source']}),
  ], authors, [{
    id: 'reviewed-conflicting-kinds',
    bookPaths: [path],
    canonicalTitle: 'Mixed Attribution',
    authorNames: ['Example Author', 'example-author'],
    authorKinds: ['person', 'entity'],
  }])

  assert.equal(plan.ambiguities.some((item) =>
    item.type === 'invalid-reviewed-group' && item.detail.includes('Conflicting kinds')),
  true)
  assert.equal(plan.groups[0].reviewedGroupId, null)
})

test('conflicting person and entity classifications block author migration', () => {
  const authors = new Map<string, MigrationAuthor>([
    ['person', author('person', 'OpenAI')],
    ['entity', {id: 'entity', name: 'OpenAI', kind: 'entity', retirement: null}],
  ])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', {isbn: '', authorIds: ['person']}),
    book('users/b/books/two', {isbn: '', authorIds: ['entity']}),
  ], authors)

  assert.equal(plan.ambiguities.some((item) => item.type === 'author-kind-conflict'), true)
  assert.equal(plan.authors.some((item) => item.canonicalName === 'OpenAI'), false)
  assert.equal(plan.candidates.every((candidate) =>
    candidate.authorProblems.includes('author-kind-conflict:openai')),
  true)
})

test('work identities over the author limit remain unlinked for review', () => {
  const authors = new Map([['source', author('source', 'Source Author')]])
  const path = 'users/a/books/one'
  const authorNames = Array.from({length: 21}, (_, index) => `Author ${index}`)
  const plan = planCrossUserCatalog([
    book(path, {isbn: '', authorIds: ['source']}),
  ], authors, [{
    id: 'reviewed-too-many-work-authors',
    bookPaths: [path],
    canonicalTitle: 'Over-authored Work',
    authorNames,
    authorKinds: authorNames.map(() => 'person' as const),
  }])

  assert.equal(plan.groups.length, 0)
  assert.equal(plan.ambiguities.some((item) => item.type === 'too-many-work-authors'), true)
})

test('personal books over the six-author write limit remain unlinked for review', () => {
  const authors = new Map<string, MigrationAuthor>()
  const authorIds = Array.from({length: 7}, (_, index) => `author-${index}`)
  for (const [index, id] of authorIds.entries()) authors.set(id, author(id, `Author ${index}`))
  const plan = planCrossUserCatalog([
    book('users/a/books/one', {isbn: '', authorIds}),
  ], authors)

  assert.equal(plan.groups.length, 0)
  assert.equal(plan.candidates[0].authorProblems.includes('too-many-personal-authors'), true)
  assert.equal(plan.ambiguities.some((item) =>
    item.type === 'unresolved-book' && item.detail.includes('too-many-personal-authors')),
  true)
})

test('reviewed works over the personal author limit do not rewrite their books', () => {
  const authors = new Map([['source', author('source', 'Source Author')]])
  const path = 'users/a/books/one'
  const authorNames = Array.from({length: 7}, (_, index) => `Reviewed Author ${index}`)
  const plan = planCrossUserCatalog([
    book(path, {isbn: '', authorIds: ['source']}),
  ], authors, [{
    id: 'reviewed-seven-authors',
    bookPaths: [path],
    canonicalTitle: 'Reviewed Work',
    authorNames,
    authorKinds: authorNames.map(() => 'person'),
  }])

  assert.equal(plan.candidates[0].authorProblems.includes('too-many-personal-authors'), true)
  assert.equal(plan.ambiguities.some((item) => item.type === 'too-many-personal-authors'), true)
  assert.deepEqual(plan.candidates[0].personalAuthorIds, ['source'])
})

test('placeholder and deleted authors never become catalog identity', () => {
  const authors = new Map<string, MigrationAuthor>([
    ['placeholder', { id: 'placeholder', name: 'Various Authors', kind: 'placeholder', retirement: null }],
    ['deleted', { id: 'deleted', name: 'Old Name', kind: 'person', retirement: { reason: 'deleted' } }],
    ['live', author('live', 'Live Author')],
  ])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', { authorIds: ['placeholder'] }),
    book('users/b/books/two', { isbn: '9781473217386', authorIds: ['deleted'] }),
    book('users/c/books/three', { isbn: '9780000000002', authorIds: ['live', 'deleted'] }),
  ], authors)

  assert.equal(plan.groups.length, 0)
  // Books one and two resolve no identity at all; book three resolves "Live
  // Author" and is held only by the deleted reference.
  assert.equal(plan.ambiguities.filter((item) => item.detail.includes('missing-resolved-author')).length, 2)
  // A deleted author the book still references is a review line, not a
  // silent drop: the client displays that name, so rewriting the book with
  // fewer authors would lose data. Both books are held back, including the
  // one whose other author resolves.
  const held = plan.ambiguities.filter((item) => item.detail.includes('deleted-author:deleted'))
  assert.deepEqual(held.map((item) => item.bookPaths).flat().sort(), ['users/b/books/two', 'users/c/books/three'])
  const three = plan.candidates.find((candidate) => candidate.book.path === 'users/c/books/three')
  assert.ok(three)
  assert.equal(three.authorProblems.includes('deleted-author:deleted'), true)
})

// Production 2026-09-01: the Holy Bible's only personal author was the
// placeholder "Various Authors", the manifest named that same name as an
// entity, and the planner dropped it by name — the work and the book were
// migrated with no author at all. The reviewed kind decides: an entity is
// minted and attached even under the placeholder name, and a placeholder
// provenance elsewhere is reclassified rather than reported as a conflict.
test('a reviewed entity under the placeholder name is minted and attached', () => {
  const uid = 'u1'
  const legacyId = `${uid}:various authors`
  const authors = new Map<string, MigrationAuthor>([
    [legacyId, { id: legacyId, name: 'Various Authors', kind: 'placeholder', retirement: null }],
    ['u2:various authors', { id: 'u2:various authors', name: 'Various Authors', kind: 'placeholder', retirement: null }],
  ])
  const path = `users/${uid}/books/bible`
  const plan = planCrossUserCatalog([
    book(path, { title: 'Holy Bible', isbn: '9780834004269', authorIds: [legacyId] }),
    book('users/u2/books/anthology', { title: 'Some Anthology', isbn: '', authorIds: ['u2:various authors'] }),
  ], authors, [{
    id: 'holy-bible',
    bookPaths: [path],
    canonicalTitle: 'Holy Bible',
    authorNames: ['Various Authors'],
    authorKinds: ['entity'],
  }])
  const entity = plan.authors.find((item) => item.canonicalName === 'Various Authors')
  assert.ok(entity, 'the reviewed entity must be minted')
  assert.equal(entity.kind, 'entity')
  assert.equal(entity.authorId, deterministicCatalogId('author', 'various authors'))
  assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].authorNames, ['Various Authors'])
  assert.deepEqual(plan.groups[0].authorIds, [entity.authorId])
  const bible = plan.candidates.find((candidate) => candidate.book.path === path)
  assert.ok(bible)
  assert.deepEqual(bible.personalAuthorIds, [entity.authorId])
  assert.deepEqual(plan.ambiguities.filter((item) => item.type === 'author-kind-conflict'), [])
  // The unreviewed anthology under the same placeholder name resolves no
  // identity and stays unlinked, as before.
  const anthology = plan.candidates.find((candidate) => candidate.book.path === 'users/u2/books/anthology')
  assert.ok(anthology)
  assert.equal(anthology.problems.includes('missing-resolved-author'), true)
  assert.equal(plan.groups.some((group) => group.candidates.includes(anthology)), false)

  // A reviewed placeholder still means "no identity".
  const dropped = planCrossUserCatalog([
    book(path, { title: 'Holy Bible', isbn: '9780834004269', authorIds: [legacyId] }),
  ], authors, [{
    id: 'holy-bible',
    bookPaths: [path],
    canonicalTitle: 'Holy Bible',
    authorNames: ['Various Authors'],
    authorKinds: ['placeholder'],
  }])
  assert.deepEqual(dropped.groups[0]?.authorIds ?? [], [])
  assert.equal(dropped.authors.some((item) => item.canonicalName === 'Various Authors'), false)
})

test('a manifest-corrected person with no personal provenance sorts by the last name token', () => {
  const authors = new Map<string, MigrationAuthor>([['kunder', author('kunder', 'Milan Kunder')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', { title: 'The Joke', authorIds: ['kunder'] }),
  ], authors, [{
    id: 'reviewed-joke',
    bookPaths: ['users/a/books/one'],
    canonicalTitle: 'The Joke',
    authorNames: ['Milan Kundera'],
    authorKinds: ['person'],
  }])
  const corrected = plan.authors.find((entry) => entry.canonicalName === 'Milan Kundera')
  assert.ok(corrected)
  assert.equal(corrected.sortName, 'Kundera')
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

test('an invalid reviewed manifest assignment remains a review finding', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one'),
  ], authors, [{
    id: 'missing-path',
    bookPaths: ['users/missing/books/nope'],
    canonicalTitle: 'Nope',
    authorNames: ['Nobody'],
    authorKinds: ['person'],
  }])

  assert.equal(plan.ambiguities[0].type, 'invalid-reviewed-group')
})

// Four of these ids are minted on both sides of the wire: the backend
// (functions/src/catalog.ts, catalogProjection.ts) and these migration and
// audit scripts each hash the same inputs. The fixture is the contract
// between the two hand-written copies; the functions-side suite asserts the
// same rows.
type CatalogIdCase = {
  kind: string
  input: Record<string, string>
  expectedId: string
}

const catalogIdCases: CatalogIdCase[] = JSON.parse(
  readFileSync(new URL('../test-fixtures/catalog-ids.json', import.meta.url), 'utf8'),
)

test('deterministic catalog ids match the shared fixture', () => {
  assert.equal(catalogIdCases.length > 0, true)
  const kinds = new Set<string>()
  for (const {kind, input, expectedId} of catalogIdCases) {
    kinds.add(kind)
    const actual =
      kind === 'catalog-author' ? deterministicCatalogId('author', input.nameKey)
      : kind === 'work-title-index' ? deterministicTitleIndexId(input.workId, input.titleKey)
      : kind === 'shared-work-owner' ? deterministicSharedWorkOwnerId(input.workId, input.uid)
      : kind === 'external-id-index' ? deterministicExternalIndexId(input.provider, input.externalId)
      : kind === 'migration-work' ? deterministicCatalogId('work', input.identityKey)
      : kind === 'migration-edition'
        ? deterministicCatalogId('edition', `${input.workId}\0${input.isbn13}`)
        : null
    assert.equal(actual, expectedId, `${kind} ${JSON.stringify(input)}`)
  }
  assert.deepEqual([...kinds].sort(), [
    'catalog-author', 'external-id-index', 'migration-edition', 'migration-work',
    'shared-work-owner', 'work-title-index',
  ])
})

test('a non-string author id is a problem, never a dropped author', () => {
  const authors = new Map([['ursula', author('ursula', 'Ursula K. Le Guin')]])
  const plan = planCrossUserCatalog([
    book('users/a/books/one', {authorIds: ['ursula', 42]}),
  ], authors)

  assert.equal(plan.candidates[0].authorProblems.includes('non-string-author-id:1'), true)
  assert.equal(plan.groups.length, 0)
  assert.equal(plan.ambiguities.some((item) =>
    item.type === 'unresolved-book' && item.detail.includes('non-string-author-id:1')),
  true)
})

test('an unknown author kind is a problem; an absent kind is the legacy person shape', () => {
  const unknownKind = new Map<string, MigrationAuthor>([
    ['corp', {id: 'corp', name: 'Acme Corp', kind: 'corporate', retirement: null}],
  ])
  const plan = planCrossUserCatalog([book('users/a/books/one', {authorIds: ['corp']})], unknownKind)
  assert.equal(plan.candidates[0].authorProblems.includes('invalid-author-kind:corp'), true)
  assert.equal(plan.authors.some((item) => item.canonicalName === 'Acme Corp'), false)
  assert.equal(plan.groups.length, 0)

  const noKind = new Map<string, MigrationAuthor>([
    ['legacy', {id: 'legacy', name: 'Legacy Author', retirement: null}],
  ])
  const legacyPlan = planCrossUserCatalog([book('users/b/books/two', {authorIds: ['legacy']})], noKind)
  assert.deepEqual(legacyPlan.candidates[0].authorProblems, [])
  assert.equal(legacyPlan.authors[0].kind, 'person')
})

// Positive control for the legacy fallback: a book with no authorIds takes
// its names from the embedded list and the single author field together,
// deduplicated by normalized key.
test('legacy embedded and single author fields collapse to one author', () => {
  const plan = planCrossUserCatalog([
    book('users/a/books/one', {
      authorIds: [], authors: [{name: 'Ada Lovelace'}], author: 'ADA LOVELACE',
    }),
  ], new Map())

  assert.deepEqual(plan.candidates[0].personalAuthors.map((entry) => entry.name), ['Ada Lovelace'])
})
