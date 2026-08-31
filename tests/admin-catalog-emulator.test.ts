import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {deleteApp as deleteClientApp, initializeApp as initializeClientApp} from 'firebase/app';
import {connectAuthEmulator, getAuth, signInWithEmailAndPassword} from 'firebase/auth';
import {deleteApp, initializeApp} from 'firebase-admin/app';
import {getAuth as getAdminAuth} from 'firebase-admin/auth';
import {FieldValue, Timestamp, getFirestore} from 'firebase-admin/firestore';
import type {AdminCatalogOperation} from '../src/lib/interfaces/catalog.ts';

const PROJECT_ID = 'book-tracker-d8f24';
const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';
const PASSWORD = 'valid-test-password';
const FUNCTIONS_ORIGIN = `http://127.0.0.1:5001/${PROJECT_ID}/europe-west1`;

// Every callable enforces App Check (SEC-068). The Functions emulator skips
// token verification and unsafe-decodes whatever JWT the header carries, so
// an unsigned emulator token stands in for the attested one a browser sends.
function emulatorAppCheckToken(): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg: 'none', typ: 'JWT'})}.${encode({
    sub: '1:emulator:web:admin-catalog-test',
    aud: [`projects/${PROJECT_ID}`],
    iss: 'https://firebaseappcheck.googleapis.com/emulator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
}

function requireLocalEmulators(): void {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):8080$/);
  assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):9099$/);
}

const workInput = (title: string, authorId: string) => ({
  canonicalTitle: title,
  alternateTitles: [],
  authorIds: [authorId],
  coverUrl: '',
  subjects: [],
  fiction: true,
});

const editionInput = (title: string, isbn13: string | null, externalIds = {}) => ({
  isbn13,
  title,
  publisher: 'Test Press',
  publishedDate: '2026',
  language: 'en',
  translatorNames: [],
  format: 'full' as const,
  suggestedPageCount: 240,
  coverUrl: '',
  externalIds,
});

test('all admin catalog operations use real callable transactions and preserve personal data', async (t) => {
  requireLocalEmulators();
  const suffix = randomUUID();
  const adminEmail = `admin-catalog-${suffix}@example.test`;
  const adminApp = initializeApp({projectId: PROJECT_ID}, `admin-catalog-emulator-${suffix}`);
  const clientApp = initializeClientApp(
    {projectId: PROJECT_ID, apiKey: 'test-key'},
    `admin-catalog-client-${suffix}`,
  );
  t.after(async () => {
    await Promise.all([deleteApp(adminApp), deleteClientApp(clientApp)]);
  });
  const adminAuth = getAdminAuth(adminApp);
  const db = getFirestore(adminApp);
  await adminAuth.createUser({
    uid: ADMIN_UID,
    email: adminEmail,
    password: PASSWORD,
    emailVerified: true,
  });
  await db.doc(`users/${ADMIN_UID}`).set({uid: ADMIN_UID});
  const clientAuth = getAuth(clientApp);
  connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', {disableWarnings: true});
  await signInWithEmailAndPassword(clientAuth, adminEmail, PASSWORD);

  async function callable<T>(name: string, data: unknown): Promise<T> {
    const token = await clientAuth.currentUser!.getIdToken();
    const response = await fetch(`${FUNCTIONS_ORIGIN}/${name}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        'x-firebase-appcheck': emulatorAppCheckToken(),
      },
      body: JSON.stringify({data}),
    });
    const payload = await response.json() as {result?: T; error?: unknown};
    if (payload.error !== undefined) throw payload.error;
    assert.ok('result' in payload, `${name} did not return a callable result`);
    return payload.result as T;
  }

  async function preview(operation: AdminCatalogOperation) {
    return callable<{
      operationId: string;
      expected: {catalog: unknown[]; books: unknown[]};
      changes: unknown[];
      touchedDocuments: number;
    }>('admin-catalogpreview', {operation});
  }

  async function previewAndApply(operation: AdminCatalogOperation) {
    const planned = await preview(operation);
    const result = await callable<{operationId: string; applied: true; touchedDocuments: number}>(
      'admin-catalogapply',
      {operationId: planned.operationId, operation, expected: planned.expected},
    );
    assert.equal(result.applied, true);
    assert.equal(result.operationId, planned.operationId);
    assert.equal(result.touchedDocuments, planned.touchedDocuments);
    return {planned, result};
  }

  const targetWorkId = `target-${suffix}`;
  const catalogAuthorId = `author-${suffix}`;
  const catalogAuthorAliasId = `author-alias-${suffix}`;
  const catalogAuthorOtherId = `author-other-${suffix}`;
  const sourceWorkId = `source-${suffix}`;
  const targetEditionId = `target-edition-${suffix}`;
  const sourceEditionId = `source-edition-${suffix}`;
  const personalUid = `reader-${suffix}`;
  const personalBookId = `book-${suffix}`;
  const isbnA = '9780140328721';
  const isbnB = '9780441478125';
  const isbnC = '9780316769488';
  const isbnD = '9781473217386';
  const isbnE = '9780061120084';
  const isbnF = '9780306406157';
  const isbnG = '9780975229804';

  await previewAndApply({
    type: 'upsertAuthor',
    authorId: catalogAuthorId,
    author: {
      canonicalName: 'Catalog Test Author', alternateNames: [],
      sortName: 'Author', kind: 'person',
    },
  });
  await previewAndApply({
    type: 'upsertAuthor',
    authorId: catalogAuthorOtherId,
    author: {
      canonicalName: 'Other Catalog Author', alternateNames: [],
      sortName: 'Author', kind: 'person',
    },
  });
  await assert.rejects(
    preview({
      type: 'upsertAuthor',
      authorId: `duplicate-author-${suffix}`,
      author: {
        canonicalName: 'Catalog Test Author', alternateNames: [],
        sortName: 'Author', kind: 'person',
      },
    }),
    (error: unknown) => (error as {status?: string}).status === 'FAILED_PRECONDITION',
  );
  await previewAndApply({
    type: 'upsertAuthor',
    authorId: catalogAuthorAliasId,
    author: {
      canonicalName: 'C. T. Author', alternateNames: [],
      sortName: 'Author', kind: 'person',
    },
  });
  await previewAndApply({
    type: 'upsertAuthor',
    authorId: catalogAuthorOtherId,
    author: {
      canonicalName: 'Other Catalog Writer',
      alternateNames: ['Other-Catalog-Author'],
      sortName: 'Writer', kind: 'person',
    },
  });
  const renamedOther = (await db.doc(`catalogAuthors/${catalogAuthorOtherId}`).get()).data()!;
  assert.deepEqual(renamedOther.alternateNames, ['Other-Catalog-Author']);
  await previewAndApply({
    type: 'upsertAuthor',
    authorId: catalogAuthorOtherId,
    author: {
      canonicalName: 'Other Catalog Writer',
      alternateNames: renamedOther.alternateNames,
      sortName: 'Writer', kind: 'person',
    },
  });

  const createTarget: AdminCatalogOperation = {
    type: 'createWork',
    workId: targetWorkId,
    status: 'active',
    work: workInput(`Target Work ${suffix}`, catalogAuthorId),
    books: [],
  };
  await previewAndApply(createTarget);
  await previewAndApply({
    type: 'createWork',
    workId: sourceWorkId,
    status: 'hidden',
    work: workInput(`Source Work ${suffix}`, catalogAuthorAliasId),
    books: [],
  });
  assert.equal((await db.doc(`works/${targetWorkId}`).get()).get('status'), 'active');

  await previewAndApply({
    type: 'upsertEdition',
    editionId: targetEditionId,
    workId: targetWorkId,
    edition: editionInput('Target Edition', isbnA, {'open-library': `OL-${suffix}`}),
  });
  await previewAndApply({
    type: 'upsertEdition',
    editionId: sourceEditionId,
    workId: sourceWorkId,
    edition: editionInput('Source Edition', isbnB),
  });
  assert.equal((await db.doc(`isbnIndex/${isbnA}`).get()).get('editionId'), targetEditionId);

  const personalUpdatedAt = Timestamp.fromMillis(1_700_000_000_000);
  const personalRef = db.doc(`users/${personalUid}/books/${personalBookId}`);
  await db.doc(`users/${personalUid}`).set({uid: personalUid});
  await personalRef.set({
    owner: db.doc(`users/${personalUid}`),
    title: 'Private reading title',
    currentPage: 73,
    pageCount: 251,
    pagesRead: 70,
    timeRead: 95,
    activeTimer: {startedAt: Timestamp.fromMillis(1_700_000_001_000)},
    privateNote: 'must survive an admin catalog link',
    authorIds: [catalogAuthorAliasId],
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
    updatedAt: personalUpdatedAt,
  });
  const mergeAuthorOperation: AdminCatalogOperation = {
    type: 'mergeAuthors',
    sourceAuthorId: catalogAuthorAliasId,
    targetAuthorId: catalogAuthorId,
  };
  const staleAuthorPreview = await preview(mergeAuthorOperation);
  await personalRef.update({authorIds: [catalogAuthorAliasId, catalogAuthorOtherId]});
  await assert.rejects(
    callable('admin-catalogapply', {
      operationId: staleAuthorPreview.operationId,
      operation: mergeAuthorOperation,
      expected: staleAuthorPreview.expected,
    }),
    (error: unknown) => {
      const callableError = error as {status?: string; details?: {reason?: string}};
      return callableError.status === 'ABORTED' && callableError.details?.reason === 'stale-preview';
    },
  );
  await personalRef.update({authorIds: [catalogAuthorAliasId]});
  await previewAndApply(mergeAuthorOperation);
  assert.deepEqual((await personalRef.get()).get('authorIds'), [catalogAuthorId]);
  assert.deepEqual((await db.doc(`works/${sourceWorkId}`).get()).get('authorIds'), [catalogAuthorId]);
  assert.equal((await db.doc(`catalogAuthors/${catalogAuthorAliasId}`).get()).get('mergedInto'), catalogAuthorId);

  const punctuationTargetId = `punctuation-target-${suffix}`;
  const punctuationSourceId = `punctuation-source-${suffix}`;
  const punctuationNow = Timestamp.now();
  const directAuthor = (canonicalName: string) => ({
    canonicalName,
    alternateNames: [],
    nameKeys: ['j r r tolkien'],
    sortName: 'Tolkien',
    kind: 'person',
    status: 'active',
    mergedFrom: [],
    createdAt: punctuationNow,
    updatedAt: punctuationNow,
  });
  await Promise.all([
    db.doc(`catalogAuthors/${punctuationTargetId}`).set(directAuthor('J R R Tolkien')),
    db.doc(`catalogAuthors/${punctuationSourceId}`).set(directAuthor('J.R.R. Tolkien')),
  ]);
  await previewAndApply({
    type: 'mergeAuthors',
    sourceAuthorId: punctuationSourceId,
    targetAuthorId: punctuationTargetId,
  });
  assert.deepEqual(
    (await db.doc(`catalogAuthors/${punctuationTargetId}`).get()).get('alternateNames'),
    [],
  );
  await previewAndApply({
    type: 'upsertAuthor',
    authorId: punctuationTargetId,
    author: {
      canonicalName: 'J R R Tolkien',
      alternateNames: [],
      sortName: 'Tolkien',
      kind: 'person',
    },
  });
  const linkOperation: AdminCatalogOperation = {
    type: 'linkBooks',
    books: [{uid: personalUid, bookId: personalBookId}],
    target: {workId: targetWorkId, editionId: targetEditionId},
  };
  await previewAndApply(linkOperation);
  const linkedPersonal = (await personalRef.get()).data()!;
  assert.equal(linkedPersonal.workId, targetWorkId);
  assert.equal(linkedPersonal.editionId, targetEditionId);
  assert.equal(linkedPersonal.matchMethod, 'admin');
  assert.equal(linkedPersonal.currentPage, 73);
  assert.equal(linkedPersonal.privateNote, 'must survive an admin catalog link');
  assert.equal(linkedPersonal.activeTimer.startedAt.toMillis(), 1_700_000_001_000);
  assert.equal(linkedPersonal.updatedAt.toMillis(), personalUpdatedAt.toMillis());

  const crossWorkIsbnRef = db.doc(`users/${personalUid}/books/cross-isbn-${suffix}`);
  const targetPriorIsbnRef = db.doc(`users/${personalUid}/books/target-prior-isbn-${suffix}`);
  await Promise.all([
    crossWorkIsbnRef.set({
      owner: db.doc(`users/${personalUid}`), title: 'Cross-work ISBN copy', isbn: isbnB,
      workId: sourceWorkId, editionId: sourceEditionId, matchMethod: 'isbn',
      linkedAt: Timestamp.now(), updatedAt: personalUpdatedAt,
    }),
    targetPriorIsbnRef.set({
      owner: db.doc(`users/${personalUid}`), title: 'Prior target ISBN copy', isbn: isbnA,
      workId: targetWorkId, editionId: targetEditionId, matchMethod: 'isbn',
      linkedAt: Timestamp.now(), updatedAt: personalUpdatedAt,
    }),
  ]);

  await previewAndApply({type: 'repointIsbn', isbn13: isbnB, editionId: targetEditionId});
  assert.equal((await db.doc(`editions/${targetEditionId}`).get()).get('isbn13'), isbnB);
  assert.equal((await db.doc(`editions/${sourceEditionId}`).get()).get('isbn13'), null);
  assert.equal((await db.doc(`isbnIndex/${isbnB}`).get()).get('editionId'), targetEditionId);
  assert.equal((await db.doc(`isbnIndex/${isbnA}`).get()).exists, false);
  assert.deepEqual(
    (await crossWorkIsbnRef.get()).data() && {
      workId: (await crossWorkIsbnRef.get()).get('workId'),
      editionId: (await crossWorkIsbnRef.get()).get('editionId'),
      matchMethod: (await crossWorkIsbnRef.get()).get('matchMethod'),
    },
    {workId: targetWorkId, editionId: targetEditionId, matchMethod: 'isbn'},
  );
  assert.equal((await targetPriorIsbnRef.get()).get('workId'), targetWorkId);
  assert.equal((await targetPriorIsbnRef.get()).get('editionId'), null);
  assert.equal((await targetPriorIsbnRef.get()).get('matchMethod'), 'admin');
  assert.equal((await targetPriorIsbnRef.get()).get('updatedAt').toMillis(), personalUpdatedAt.toMillis());

  const sameWorkEditionId = `same-work-edition-${suffix}`;
  await previewAndApply({
    type: 'upsertEdition', editionId: sameWorkEditionId, workId: targetWorkId,
    edition: editionInput('Same-work Edition', isbnC),
  });
  const sameWorkIsbnRef = db.doc(`users/${personalUid}/books/same-work-isbn-${suffix}`);
  await sameWorkIsbnRef.set({
    owner: db.doc(`users/${personalUid}`), title: 'Same-work ISBN copy', isbn: isbnC,
    workId: targetWorkId, editionId: sameWorkEditionId, matchMethod: 'isbn',
    linkedAt: Timestamp.now(), updatedAt: personalUpdatedAt,
  });
  await previewAndApply({type: 'repointIsbn', isbn13: isbnC, editionId: targetEditionId});
  assert.equal((await sameWorkIsbnRef.get()).get('workId'), targetWorkId);
  assert.equal((await sameWorkIsbnRef.get()).get('editionId'), targetEditionId);
  assert.equal((await sameWorkIsbnRef.get()).get('matchMethod'), 'isbn');
  assert.equal((await crossWorkIsbnRef.get()).get('editionId'), null);
  assert.equal((await crossWorkIsbnRef.get()).get('matchMethod'), 'admin');
  assert.equal((await db.doc(`editions/${sameWorkEditionId}`).get()).get('isbn13'), null);
  assert.equal((await db.doc(`isbnIndex/${isbnB}`).get()).exists, false);
  assert.equal((await db.doc(`isbnIndex/${isbnC}`).get()).get('editionId'), targetEditionId);

  const staleRepoint: AdminCatalogOperation = {
    type: 'repointIsbn', isbn13: isbnD, editionId: targetEditionId,
  };
  const staleRepointPreview = await preview(staleRepoint);
  await sameWorkIsbnRef.update({isbn: isbnD});
  await assert.rejects(
    callable('admin-catalogapply', {
      operationId: staleRepointPreview.operationId,
      operation: staleRepoint,
      expected: staleRepointPreview.expected,
    }),
    (error: unknown) => {
      const callableError = error as {status?: string; details?: {reason?: string}};
      return callableError.status === 'ABORTED' && callableError.details?.reason === 'stale-preview';
    },
  );
  assert.equal((await db.doc(`isbnIndex/${isbnD}`).get()).exists, false);
  await sameWorkIsbnRef.update({isbn: isbnC});

  const danglingRepairEditionId = `dangling-repair-${suffix}`;
  await previewAndApply({
    type: 'upsertEdition', editionId: danglingRepairEditionId, workId: targetWorkId,
    edition: editionInput('Dangling repair target', null),
  });
  await db.doc(`isbnIndex/${isbnD}`).set({
    workId: sourceWorkId, editionId: `missing-edition-${suffix}`,
  });
  await previewAndApply({type: 'repointIsbn', isbn13: isbnD, editionId: danglingRepairEditionId});
  assert.deepEqual((await db.doc(`isbnIndex/${isbnD}`).get()).data(), {
    workId: targetWorkId, editionId: danglingRepairEditionId,
  });

  const corruptRepairEditionId = `corrupt-repair-${suffix}`;
  await previewAndApply({
    type: 'upsertEdition', editionId: corruptRepairEditionId, workId: targetWorkId,
    edition: editionInput('Corrupt repair target', null),
  });
  await db.doc(`isbnIndex/${isbnE}`).set({workId: sourceWorkId, editionId: sourceEditionId});
  await previewAndApply({type: 'repointIsbn', isbn13: isbnE, editionId: corruptRepairEditionId});
  assert.equal((await db.doc(`editions/${sourceEditionId}`).get()).get('isbn13'), null);
  assert.deepEqual((await db.doc(`isbnIndex/${isbnE}`).get()).data(), {
    workId: targetWorkId, editionId: corruptRepairEditionId,
  });

  const capacityTargetEditionId = `capacity-target-${suffix}`;
  const capacityOldEditionId = `capacity-old-${suffix}`;
  const capacityNow = Timestamp.now();
  const capacityBatch = db.batch();
  capacityBatch.set(db.doc(`editions/${capacityTargetEditionId}`), {
    ...editionInput('Capacity target', isbnF), workId: targetWorkId,
    createdAt: capacityNow, updatedAt: capacityNow,
  });
  capacityBatch.set(db.doc(`editions/${capacityOldEditionId}`), {
    ...editionInput('Capacity old', isbnG), workId: targetWorkId,
    createdAt: capacityNow, updatedAt: capacityNow,
  });
  capacityBatch.set(db.doc(`isbnIndex/${isbnF}`), {
    workId: targetWorkId, editionId: capacityTargetEditionId,
  });
  capacityBatch.set(db.doc(`isbnIndex/${isbnG}`), {
    workId: targetWorkId, editionId: capacityOldEditionId,
  });
  const capacityBookRefs: Array<ReturnType<typeof db.doc>> = [];
  for (let index = 0; index < 101; index += 1) {
    const targetSide = index < 51;
    const ref = db.doc(`users/${personalUid}/books/capacity-${suffix}-${index}`);
    capacityBookRefs.push(ref);
    capacityBatch.set(ref, {
      owner: db.doc(`users/${personalUid}`), title: `Capacity copy ${index}`,
      isbn: targetSide ? isbnF : isbnG, workId: targetWorkId,
      editionId: targetSide ? capacityTargetEditionId : capacityOldEditionId,
      matchMethod: 'isbn', linkedAt: capacityNow, updatedAt: personalUpdatedAt,
    });
  }
  await capacityBatch.commit();
  await assert.rejects(
    preview({type: 'repointIsbn', isbn13: isbnG, editionId: capacityTargetEditionId}),
    (error: unknown) => {
      const callableError = error as {status?: string; details?: {reason?: string}};
      return callableError.status === 'RESOURCE_EXHAUSTED' &&
        callableError.details?.reason === 'operation-too-large';
    },
  );
  const capacityCleanup = db.batch();
  for (const ref of capacityBookRefs) capacityCleanup.delete(ref);
  capacityCleanup.delete(db.doc(`editions/${capacityTargetEditionId}`));
  capacityCleanup.delete(db.doc(`editions/${capacityOldEditionId}`));
  capacityCleanup.delete(db.doc(`isbnIndex/${isbnF}`));
  capacityCleanup.delete(db.doc(`isbnIndex/${isbnG}`));
  await capacityCleanup.commit();

  const editOperation: AdminCatalogOperation = {
    type: 'editWork',
    workId: targetWorkId,
    status: 'active',
    work: {...workInput(`Target Work ${suffix}`, catalogAuthorId), alternateTitles: ['The Target Alias']},
  };
  const edit = await previewAndApply(editOperation);
  const replay = await callable<{operationId: string; applied: true; touchedDocuments: number}>(
    'admin-catalogapply',
    {operationId: edit.planned.operationId, operation: editOperation, expected: edit.planned.expected},
  );
  assert.deepEqual(replay, edit.result);
  const replayAudits = await db.collection('adminAudit')
    .where('operationId', '==', edit.planned.operationId).get();
  assert.equal(replayAudits.size, 1);

  await Promise.all([
    db.doc(`users/${ADMIN_UID}`).set({uid: ADMIN_UID}),
    db.doc(`users/${ADMIN_UID}/books/source-provenance-${suffix}`).set({
      owner: db.doc(`users/${ADMIN_UID}`),
      title: 'Operator-approved source',
      workId: sourceWorkId,
      editionId: sourceEditionId,
      matchMethod: 'admin',
      linkedAt: Timestamp.now(),
    }),
  ]);

  await previewAndApply({
    type: 'mergeWorks',
    sourceWorkIds: [sourceWorkId],
    targetWorkId,
  });
  assert.equal((await db.doc(`works/${sourceWorkId}`).get()).get('mergedInto'), targetWorkId);
  assert.equal((await db.doc(`editions/${sourceEditionId}`).get()).get('workId'), targetWorkId);

  const staleBookId = `stale-${suffix}`;
  const staleRef = db.doc(`users/${personalUid}/books/${staleBookId}`);
  await staleRef.set({
    owner: db.doc(`users/${personalUid}`),
    title: 'Concurrent link', workId: null, editionId: null, matchMethod: null,
    linkedAt: null, updatedAt: personalUpdatedAt,
  });
  const staleOperation: AdminCatalogOperation = {
    type: 'linkBooks',
    books: [{uid: personalUid, bookId: staleBookId}],
    target: {workId: targetWorkId, editionId: targetEditionId},
  };
  const stalePreview = await preview(staleOperation);
  await staleRef.update({
    workId: sourceWorkId,
    editionId: sourceEditionId,
    matchMethod: 'catalog-choice',
    linkedAt: FieldValue.serverTimestamp(),
  });
  await assert.rejects(
    callable('admin-catalogapply', {
      operationId: stalePreview.operationId,
      operation: staleOperation,
      expected: stalePreview.expected,
    }),
    (error: unknown) => {
      const callableError = error as {status?: string; details?: {reason?: string}};
      return callableError.status === 'ABORTED' && callableError.details?.reason === 'stale-preview';
    },
  );
  assert.equal((await staleRef.get()).get('matchMethod'), 'catalog-choice');

  // Open-signup data is paged instead of participating in the operator-owned
  // catalog bounds. One account with >500 books and >100 unrelated user roots
  // must not make the first or subsequent admin page unavailable.
  const attackerUid = `attacker-${suffix}`;
  const scanNow = Timestamp.now();
  const attackerWrites: Array<{path: string; data: Record<string, unknown>}> = [];
  const overLimitBookId = `too-many-authors-${suffix}`;
  const overLimitAuthorIds = Array.from({length: 7}, (_, index) => `scan-author-${index}-${suffix}`);
  for (const authorId of overLimitAuthorIds) {
    attackerWrites.push({
      path: `catalogAuthors/${authorId}`,
      data: {
        canonicalName: authorId, alternateNames: [], nameKeys: [authorId],
        sortName: authorId, kind: 'person', status: 'active', mergedFrom: [],
        createdAt: scanNow, updatedAt: scanNow,
      },
    });
  }
  attackerWrites.push({
    path: `users/${personalUid}/books/${overLimitBookId}`,
    data: {
      title: 'Seven-author personal shadow', authorIds: overLimitAuthorIds,
      isbn: '', pageCount: 100, publisher: '', publishedDate: '', coverUrl: '',
      workId: null, editionId: null, matchMethod: null, linkedAt: null,
      createdAt: scanNow, updatedAt: scanNow,
    },
  });
  for (let index = 0; index < 600; index += 1) {
    attackerWrites.push({
      path: `users/${attackerUid}/books/attack-${String(index).padStart(4, '0')}`,
      data: {
        title: `Attack Book ${index}`,
        authors: [{name: 'Attacker Author'}],
        isbn: '',
        pageCount: 100,
        publisher: '',
        publishedDate: '',
        coverUrl: '',
        workId: null,
        editionId: null,
        matchMethod: null,
        linkedAt: null,
        createdAt: scanNow,
        updatedAt: scanNow,
      },
    });
  }
  for (let index = 0; index < 150; index += 1) {
    attackerWrites.push({
      path: `users/signup-${suffix}-${index}`,
      data: {uid: `signup-${suffix}-${index}`},
    });
  }
  for (let offset = 0; offset < attackerWrites.length; offset += 400) {
    const attackerBatch = db.batch();
    for (const write of attackerWrites.slice(offset, offset + 400)) {
      attackerBatch.set(db.doc(write.path), write.data);
    }
    await attackerBatch.commit();
  }
  const firstScan = await callable<{
    books: Array<{uid: string; bookId: string}>;
    works: Array<{workId: string; linkedBookCount: number}>;
    findings: Array<{code: string; workIds: string[]; editionIds: string[]; books: Array<{uid: string; bookId: string}>}>;
    nextBookCursor: string | null;
    bookCountsComplete: boolean;
    limits: {books: number};
  }>('admin-catalogscan', {});
  assert.equal(firstScan.books.length, 100);
  assert.equal(firstScan.limits.books, 100);
  assert.equal(firstScan.bookCountsComplete, false);
  assert.match(firstScan.nextBookCursor ?? '', /^users\/[^/]+\/books\/[^/]+$/);
  const secondScan = await callable<{
    books: Array<{uid: string; bookId: string}>;
    works: Array<{workId: string; linkedBookCount: number}>;
    findings: Array<{code: string; workIds: string[]; editionIds: string[]; books: Array<{uid: string; bookId: string}>}>;
    nextBookCursor: string | null;
    bookCountsComplete: boolean;
  }>('admin-catalogscan', {bookCursor: firstScan.nextBookCursor});
  assert.equal(secondScan.books.length, 100);
  assert.equal(secondScan.bookCountsComplete, false);
  const pages = [firstScan, secondScan];
  let scanCursor = secondScan.nextBookCursor;
  while (scanCursor !== null) {
    assert.ok(pages.length < 20, 'admin scan cursor did not converge');
    const page = await callable<typeof secondScan>('admin-catalogscan', {bookCursor: scanCursor});
    pages.push(page);
    scanCursor = page.nextBookCursor;
  }
  const allRows = pages.flatMap((page) => page.books);
  assert.equal(allRows.filter((book) => book.uid === attackerUid).length, 600);
  assert.equal(new Set(allRows.map((book) => `${book.uid}/${book.bookId}`)).size, allRows.length);
  const findingSignatures = pages.flatMap((page) => page.findings).map((finding) => JSON.stringify([
    finding.code, finding.workIds, finding.editionIds, finding.books,
  ]));
  assert.equal(new Set(findingSignatures).size, findingSignatures.length);
  assert.equal(pages.some((page) => page.findings.some((finding) =>
    finding.code === 'book-link-anomaly' &&
    finding.books.some((book) => book.uid === personalUid && book.bookId === overLimitBookId),
  )), true);
  assert.equal(pages.reduce((total, page) => total +
    (page.works.find((work) => work.workId === targetWorkId)?.linkedBookCount ?? 0), 0), 6);

  const largeTargetId = `large-target-${suffix}`;
  const largeSourceId = `large-source-${suffix}`;
  const now = Timestamp.now();
  const directWork = (title: string) => ({
    ...workInput(title, catalogAuthorId),
    titleKeys: [title.toLocaleLowerCase('en-US')],
    status: 'hidden',
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  });
  await Promise.all([
    db.doc(`works/${largeTargetId}`).set(directWork(`Large Target ${suffix}`)),
    db.doc(`works/${largeSourceId}`).set(directWork(`Large Source ${suffix}`)),
  ]);
  const batch = db.batch();
  for (let index = 0; index < 201; index += 1) {
    batch.set(db.doc(`editions/large-${suffix}-${index}`), {
      ...editionInput(`Large Edition ${index}`, null),
      workId: largeSourceId,
      createdAt: now,
      updatedAt: now,
    });
  }
  await batch.commit();
  await assert.rejects(
    preview({type: 'mergeWorks', sourceWorkIds: [largeSourceId], targetWorkId: largeTargetId}),
    (error: unknown) => {
      const callableError = error as {status?: string; details?: {reason?: string; maxTouchedDocuments?: number}};
      return callableError.status === 'RESOURCE_EXHAUSTED' &&
        callableError.details?.reason === 'operation-too-large' &&
        callableError.details.maxTouchedDocuments === 200;
    },
  );

  const postDeleteOperation: AdminCatalogOperation = {
    type: 'editWork', workId: targetWorkId, status: 'active',
    work: {...workInput(`Target Work ${suffix}`, catalogAuthorId), alternateTitles: ['Post-delete denial']},
  };
  const postDeletePreview = await preview(postDeleteOperation);
  await db.doc(`users/${ADMIN_UID}`).update({deletedAt: Timestamp.now()});
  const denied = (error: unknown) => (error as {status?: string}).status === 'NOT_FOUND';
  await assert.rejects(callable('admin-catalogscan', {}), denied);
  await assert.rejects(callable('admin-catalogpreview', {operation: postDeleteOperation}), denied);
  await assert.rejects(callable('admin-catalogapply', {
    operationId: postDeletePreview.operationId,
    operation: postDeleteOperation,
    expected: postDeletePreview.expected,
  }), denied);
});
