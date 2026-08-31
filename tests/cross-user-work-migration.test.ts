import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deterministicCatalogId,
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
    authorKinds: ['person'],
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
    authorKinds: ['person'],
  }])

  assert.equal(plan.ambiguities[0].type, 'invalid-reviewed-group')
})
