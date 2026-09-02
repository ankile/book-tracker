import { createHash, randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const PROJECT_ID = 'book-tracker-d8f24';
const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';
const PASSWORD = 'valid-test-password';

function sharedWorkOwnerId(workId: string, uid: string): string {
  return createHash('sha256').update(`${workId}\0${uid}`).digest('hex');
}

function catalogAuthorId(nameKey: string): string {
  return `author_${createHash('sha256').update(`author\0${nameKey}`).digest('hex').slice(0, 24)}`;
}

async function waitForDocument(
  db: ReturnType<typeof getFirestore>,
  path: string,
  expectedExists: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await db.doc(path).get()).exists === expectedExists) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${path} did not converge to exists=${expectedExists}.`);
}

async function waitForBookByTitle(
  db: ReturnType<typeof getFirestore>,
  uid: string,
  title: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const books = await db.collection(`users/${uid}/books`).where('title', '==', title).get();
    if (books.size === 1) return books.docs[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`users/${uid}/books did not gain exactly one ${title} row.`);
}

function requireLocalEmulators(): void {
  if (!/^(?:127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('Catalog browser tests require the local Firestore emulator.');
  }
  if (!/^(?:127\.0\.0\.1|localhost):9099$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) {
    throw new Error('Catalog browser tests require the local Auth emulator.');
  }
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address', {exact: true}).fill(email);
  await page.getByLabel('Password', {exact: true}).fill(PASSWORD);
  await page.getByRole('button', {name: 'Log in', exact: true}).click();
  await expect(page.getByRole('navigation', {name: 'Primary navigation'})).toBeVisible();
}

async function chooseExistingAuthor(page: Page, name: string): Promise<void> {
  await page.getByLabel('Author', {exact: true}).fill(name);
  await page.getByRole('option', {name, exact: true}).click();
}

async function openNewBook(page: Page): Promise<void> {
  await page.goto('/me');
  await page.getByRole('navigation', {name: 'Primary navigation'})
    .getByRole('button', {name: '+ Add book', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Add new book'})).toBeVisible();
}

async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((href) => {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = 'Test navigation';
    document.body.append(link);
    link.click();
  }, path);
  await page.waitForURL(`**${path}`);
}

function unsignedEmulatorIdToken({
  uid,
  email,
  authTime,
}: {
  uid: string;
  email: string;
  authTime: number;
}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({alg: 'none', typ: 'JWT'})}.${encode({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: authTime,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    email,
    email_verified: true,
    firebase: {identities: {email: [email]}, sign_in_provider: 'password'},
  })}.`;
}

async function agePersistedAuthSession(
  context: BrowserContext,
  page: Page,
  uid: string,
  email: string,
): Promise<void> {
  const authKey = await page.evaluate(() => (
    Object.keys(localStorage).find((key) => key.startsWith('firebase:authUser:')) ?? null
  ));
  if (authKey === null) throw new Error('Firebase Auth persistence key was not found.');
  const staleToken = unsignedEmulatorIdToken({
    uid,
    email,
    authTime: Math.floor(Date.now() / 1000) - 901,
  });
  const writer = await context.newPage();
  await writer.goto('/');
  await writer.evaluate(({key, token}) => {
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error('Firebase Auth persistence entry disappeared.');
    const value = JSON.parse(raw) as {stsTokenManager: {accessToken: string; expirationTime: number}};
    value.stsTokenManager.accessToken = token;
    value.stsTokenManager.expirationTime = Date.now() + 60 * 60 * 1000;
    localStorage.setItem(key, JSON.stringify(value));
  }, {key: authKey, token: staleToken});
  await writer.close();
  await page.waitForTimeout(250);
}

test.describe.serial('shared catalog through Auth, Firestore, and Functions emulators', () => {
  const suffix = randomUUID();
  const normalUid = `catalog-user-${suffix}`;
  const normalEmail = `${normalUid}@example.test`;
  const readerUid = `catalog-reader-${suffix}`;
  const readerEmail = `${readerUid}@example.test`;
  const readerUsername = `reader-${suffix}`.slice(0, 30);
  const renamedReaderUsername = `renamed-${suffix}`.slice(0, 30);
  const revokedUid = `catalog-revoked-${suffix}`;
  const revokedUsername = `revoked-${suffix}`.slice(0, 30);
  const adminEmail = `catalog-admin-${suffix}@example.test`;
  const workId = `left-hand-${suffix}`;
  const leGuinAuthorId = `le-guin-${suffix}`;
  const dahlAuthorId = `dahl-${suffix}`;
  const editionId = `left-hand-edition-${suffix}`;
  const newAuthorName = `Unique Shared Author ${suffix.slice(0, 8)}`;
  const newAuthorKey = newAuthorName.toLowerCase();
  const isbn = '9780441478125';
  const app = initializeApp({projectId: PROJECT_ID}, `catalog-e2e-${suffix}`);
  const auth = getAuth(app);
  const db = getFirestore(app);

  test.beforeAll(async () => {
    requireLocalEmulators();
    await Promise.all([
      auth.createUser({uid: normalUid, email: normalEmail, password: PASSWORD, emailVerified: true}),
      auth.createUser({uid: readerUid, email: readerEmail, password: PASSWORD, emailVerified: true}),
      auth.createUser({uid: ADMIN_UID, email: adminEmail, password: PASSWORD, emailVerified: true}),
    ]);
    const now = Timestamp.now();
    const normalRef = db.doc(`users/${normalUid}`);
    const readerRef = db.doc(`users/${readerUid}`);
    const readerBookRef = readerRef.collection('books').doc(`shared-attempt-${suffix}`);
    await Promise.all([
      normalRef.set({uid: normalUid, email: normalEmail}),
      readerRef.set({uid: readerUid, email: readerEmail}),
      db.doc(`users/${revokedUid}`).set({uid: revokedUid, email: `${revokedUid}@example.test`}),
      db.doc(`users/${ADMIN_UID}`).set({uid: ADMIN_UID, email: adminEmail}),
      db.doc(`catalogAuthors/${leGuinAuthorId}`).set({
        canonicalName: 'Ursula K. Le Guin', alternateNames: [], nameKeys: ['ursula k le guin'],
        sortName: 'Le Guin', kind: 'person', status: 'active', mergedFrom: [],
        createdAt: now, updatedAt: now,
      }),
      db.doc(`catalogAuthors/${dahlAuthorId}`).set({
        canonicalName: 'Roald Dahl', alternateNames: [], nameKeys: ['roald dahl'],
        sortName: 'Dahl', kind: 'person', status: 'active', mergedFrom: [],
        createdAt: now, updatedAt: now,
      }),
      db.doc(`works/${workId}`).set({
        canonicalTitle: 'The Left Hand of Darkness', alternateTitles: [],
        titleKeys: ['left hand of darkness'], authorIds: [leGuinAuthorId],
        coverUrl: 'https://example.test/work-cover.jpg', subjects: ['Science fiction'],
        fiction: true, status: 'active', mergedFrom: [],
        createdAt: now, updatedAt: now,
      }),
      db.doc(`editions/${editionId}`).set({
        workId, isbn13: isbn, title: 'The Left Hand of Darkness',
        publisher: 'Ace', publishedDate: '1987',
        language: 'en', translatorNames: [], format: 'full', suggestedPageCount: 304,
        coverUrl: 'https://example.test/edition-cover.jpg', externalIds: {}, createdAt: now, updatedAt: now,
      }),
      db.doc(`isbnIndex/${isbn}`).set({workId, editionId}),
      db.doc(`workTitleIndex/${workId}-title`).set({
        workId, title: 'The Left Hand of Darkness', titleKey: 'left hand of darkness',
        status: 'active',
      }),
      db.doc(`profiles/${readerUsername}`).set({
        uid: readerUid, givenName: 'Shared', familyName: 'Reader', public: true,
      }),
      db.doc(`profileOwners/${readerUid}`).set({username: readerUsername}),
      db.doc(`profiles/${revokedUsername}`).set({
        uid: revokedUid, givenName: 'Revoked', familyName: 'Reader', public: true,
      }),
      db.doc(`profileOwners/${revokedUid}`).set({username: revokedUsername}),
      db.doc(`users/${readerUid}/settings/bookSharing`).set({
        enabled: true, timeZone: 'America/Los_Angeles',
        createdAt: now, updatedAt: now,
      }),
      // Sharing is on by default; the revoked reader opted out.
      db.doc(`users/${revokedUid}/settings/bookSharing`).set({
        enabled: false, timeZone: 'UTC',
        createdAt: now, updatedAt: now,
      }),
    ]);
    await readerBookRef.set({
      owner: readerRef, authorIds: [leGuinAuthorId], title: 'Personal Left Hand', activeTimer: null,
      currentPage: 304, currentPageUpdateId: null, pageCount: 304, finished: true, finishedAt: now,
      pagesRead: 304, timeRead: 240, isbn, coverUrl: '', publisher: 'Ace', publishedDate: '1987',
      subjects: [], fiction: true, workId, editionId, matchMethod: 'migration', linkedAt: now,
      createdAt: now, updatedAt: now,
    });
    await readerBookRef.collection('updates').doc(`reading-${suffix}`).set({
      owner: readerRef, book: readerBookRef, type: 'reading', fromPage: 0, toPage: 304,
      pagesRead: 304, timeRead: 240, createdAt: now, updatedAt: now,
    });
    await normalRef.collection('books').doc(`unmatched-${suffix}`).set({
      owner: normalRef, authorIds: [dahlAuthorId], title: 'Needs catalog review', activeTimer: null,
      currentPage: 0, currentPageUpdateId: null, pageCount: 99, finished: false,
      pagesRead: 0, timeRead: 0, isbn: '', coverUrl: '', publisher: '', publishedDate: '',
      subjects: [], fiction: null, workId: null, editionId: null, matchMethod: null, linkedAt: null,
      createdAt: now, updatedAt: now,
    });
    // The projection is only a bounded lookup accelerator. The callable
    // must re-check live consent, so this deliberately stale row for an
    // owner who opted out can never produce a reader.
    await db.doc(`sharedWorkOwners/${sharedWorkOwnerId(workId, revokedUid)}`).set({
        uid: revokedUid, workId, updatedAt: now,
    });
    await waitForDocument(
      db,
      `sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`,
      true,
    );
  });

  test.afterAll(async () => {
    await deleteApp(app);
  });

  test('regular users get suggestions, can unlink/relink and reread, and consent changes converge', async ({browser}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const reloadWorkPage = async (): Promise<void> => {
      // The lifecycle assertions reload the work page more often than the
      // hourly reader-summary limit allows. Clearing only this emulator
      // user's counter keeps each reload a test of consent convergence.
      await db.doc(`users/${normalUid}/functionQuotas/workReaders`).delete();
      await page.reload();
    };
    try {
      await login(page, normalEmail);
      await openNewBook(page);
      await chooseExistingAuthor(page, 'Ursula K. Le Guin');
      await page.getByLabel('Book title', {exact: true}).fill('The Left Hand of Darkness');
      await page.getByLabel("Your edition's page count", {exact: true}).fill('320');
      await page.getByLabel('ISBN number (optional)', {exact: true}).fill(isbn);
      const catalog = page.getByLabel('Shared book catalog');
      await expect(catalog.getByText('The Left Hand of Darkness', {exact: true}).first()).toBeVisible();
      await expect(catalog.getByRole('button', {name: 'Remove link'})).toBeVisible();
      await expect(page.getByAltText('Cover of The Left Hand of Darkness')).toHaveAttribute(
        'src',
        'https://example.test/edition-cover.jpg',
      );
      await expect(page.getByText('Fiction', {exact: true})).toBeVisible();
      await expect(page.getByText('Science fiction', {exact: true})).toBeVisible();
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      await expect(page.getByRole('dialog', {name: 'Add new book'})).toHaveCount(0);
      await openNewBook(page);
      await expect(page.getByLabel('Book title', {exact: true})).toHaveValue('');
      await expect(page.getByLabel("Your edition's page count", {exact: true})).toHaveValue('');
      await expect(page.getByLabel('ISBN number (optional)', {exact: true})).toHaveValue('');
      await expect(page.getByRole('button', {name: 'Remove link'})).toHaveCount(0);
      await page.getByRole('button', {name: 'Close', exact: true}).click();
      await page.goto('/');
      await expect(page.getByText('The Left Hand of Darkness', {exact: true})).toBeVisible();
      await expect(page.getByRole('link', {name: 'Linked work'})).toBeVisible();

      await page.getByRole('button', {name: 'Edit The Left Hand of Darkness'}).click();
      await page.getByRole('button', {name: 'Remove link'}).click();
      await page.getByRole('button', {name: 'Update book', exact: true}).click();
      await expect(page.getByRole('link', {name: 'Linked work'})).toHaveCount(0);

      await page.getByRole('button', {name: 'Edit The Left Hand of Darkness'}).click();
      await expect(page.getByRole('button', {name: 'Remove link'})).toBeVisible();
      await page.getByRole('button', {name: 'Update book', exact: true}).click();
      await expect(page.getByRole('link', {name: 'Linked work'})).toBeVisible();

      await openNewBook(page);
      await chooseExistingAuthor(page, 'Ursula K. Le Guin');
      await page.getByLabel('Book title', {exact: true}).fill('The Left Hand of Darkness');
      await page.getByLabel("Your edition's page count", {exact: true}).fill('304');
      await page.getByLabel('ISBN number (optional)', {exact: true}).fill(isbn);
      await expect(page.getByText(/already have a reading record for this work/i)).toBeVisible();
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      await page.goto('/');
      await expect(page.getByRole('link', {name: 'Linked work'})).toHaveCount(2);

      await page.getByRole('link', {name: 'Linked work'}).first().click();
      await expect(page.getByRole('heading', {name: 'Readers'})).toBeVisible();
      await expect(page.getByRole('link', {name: 'Shared Reader'})).toBeVisible();
      // Two cards: the named shared reader and the signed-in user's own
      // anonymous card (sharing is on by default; no profile yet). The
      // opted-out reader's stale row produces nothing.
      await expect(page.locator('.reader-card')).toHaveCount(2);
      await expect(page.getByRole('heading', {name: 'A reader'})).toHaveCount(1);
      await expect(page.getByText('Revoked Reader')).toHaveCount(0);
      await expect(page.getByText('304', {exact: true}).first()).toBeVisible();
      await expect(page.getByText(/pages\/hour/).first()).toBeVisible();

      // Identity is separate from consent: a private profile makes the
      // reader anonymous, not absent — the row stays.
      await db.doc(`profiles/${readerUsername}`).update({public: false});
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Shared Reader'})).toHaveCount(0);
      await expect(page.getByRole('heading', {name: 'A reader'})).toHaveCount(2);
      await expect(page.locator('.reader-card')).toHaveCount(2);
      expect((await db.doc(`sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`).get()).exists).toBe(true);

      await db.doc(`profiles/${readerUsername}`).update({public: true});
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Shared Reader'})).toBeVisible();

      // Opting out withdraws the row; opting back in restores it.
      await db.doc(`users/${readerUid}/settings/bookSharing`).update({enabled: false});
      await waitForDocument(db, `sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`, false);
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Shared Reader'})).toHaveCount(0);
      await expect(page.locator('.reader-card')).toHaveCount(1);

      await db.doc(`users/${readerUid}/settings/bookSharing`).update({enabled: true});
      await waitForDocument(db, `sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`, true);
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Shared Reader'})).toBeVisible();

      // A rename follows the ownership record; deleting the profile leaves
      // an anonymous reader; recreating it names them again.
      const rename = db.batch();
      rename.set(db.doc(`profiles/${renamedReaderUsername}`), {
        uid: readerUid, givenName: 'Renamed', familyName: 'Reader', public: true,
      });
      rename.set(db.doc(`profileOwners/${readerUid}`), {username: renamedReaderUsername});
      rename.delete(db.doc(`profiles/${readerUsername}`));
      await rename.commit();
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Renamed Reader'})).toBeVisible();

      const deleteProfile = db.batch();
      deleteProfile.delete(db.doc(`profiles/${renamedReaderUsername}`));
      deleteProfile.delete(db.doc(`profileOwners/${readerUid}`));
      await deleteProfile.commit();
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Renamed Reader'})).toHaveCount(0);
      await expect(page.getByRole('heading', {name: 'A reader'})).toHaveCount(2);
      expect((await db.doc(`sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`).get()).exists).toBe(true);

      const recreate = db.batch();
      recreate.set(db.doc(`profiles/${renamedReaderUsername}`), {
        uid: readerUid, givenName: 'Renamed', familyName: 'Reader', public: true,
      });
      recreate.set(db.doc(`profileOwners/${readerUid}`), {username: renamedReaderUsername});
      await recreate.commit();
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Renamed Reader'})).toBeVisible();

      // A tombstoned account stops sharing: the account trigger withdraws
      // the row and the callable hides the reader even before it lands.
      await auth.deleteUser(readerUid);
      await waitForDocument(db, `sharedWorkOwners/${sharedWorkOwnerId(workId, readerUid)}`, false);
      await waitForDocument(db, `profiles/${renamedReaderUsername}`, true);
      const tombstonedProfile = await db.doc(`profiles/${renamedReaderUsername}`).get();
      expect(tombstonedProfile.get('deletedAt') instanceof Timestamp).toBe(true);
      expect(tombstonedProfile.get('public')).toBe(true);
      expect(tombstonedProfile.get('givenName')).toBe('Renamed');
      expect(tombstonedProfile.get('familyName')).toBe('Reader');
      // Soft delete: the setting stays like every other document; the
      // account tombstone is what withdrew the projection row above.
      expect((await db.doc(`users/${readerUid}/settings/bookSharing`).get()).exists).toBe(true);
      await reloadWorkPage();
      await expect(page.getByRole('link', {name: 'Renamed Reader'})).toHaveCount(0);
      await expect(page.locator('.reader-card')).toHaveCount(1);


      await openNewBook(page);
      await chooseExistingAuthor(page, 'Roald Dahl');
      await page.getByLabel('Book title', {exact: true}).fill('Matilda');
      await page.getByLabel("Your edition's page count", {exact: true}).fill('240');
      await page.getByLabel('ISBN number (optional)', {exact: true}).fill('9780140328721');
      await expect(page.getByText(/Saving creates a shared work/i)).toBeVisible();
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      // Creation is a callable round trip before the book write is queued,
      // so the dialog closing is the signal that the save was accepted.
      await expect(page.getByRole('dialog', {name: 'Add new book'})).toHaveCount(0);
      await page.goto('/');
      await expect(page.getByText('Matilda', {exact: true})).toBeVisible();
      // A book that matched nothing seeded the shared catalog itself: a
      // work by this user, its edition on the ISBN, and the
      // personal book linked to both.
      const matilda = await waitForBookByTitle(db, normalUid, 'Matilda');
      expect(typeof matilda.get('workId')).toBe('string');
      expect(typeof matilda.get('editionId')).toBe('string');
      const createdWork = await db.doc(`works/${matilda.get('workId')}`).get();
      expect(createdWork.get('canonicalTitle')).toBe('Matilda');
      expect(createdWork.get('status')).toBe('active');
      expect(createdWork.get('createdBy')).toBe(normalUid);
      expect((await db.doc('isbnIndex/9780140328721').get()).get('editionId')).toBe(matilda.get('editionId'));
      expect((await db.doc(`editions/${matilda.get('editionId')}`).get()).get('createdBy')).toBe(normalUid);

      // A work chosen by title, with no matching edition, gets this book's
      // own edition added to it: every linked book stands on an edition.
      await openNewBook(page);
      await chooseExistingAuthor(page, 'Ursula K. Le Guin');
      await page.getByLabel('Book title', {exact: true}).fill('Left Hand of Darkness');
      await page.getByLabel("Your edition's page count", {exact: true}).fill('320');
      await page.getByRole('button', {name: 'Use this work'}).first().click();
      await expect(page.getByRole('button', {name: 'Remove link'})).toBeVisible();
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      await expect(page.getByRole('dialog', {name: 'Add new book'})).toHaveCount(0);
      const titleChoice = await waitForBookByTitle(db, normalUid, 'Left Hand of Darkness');
      expect(titleChoice.get('workId')).toBe(workId);
      expect(typeof titleChoice.get('editionId')).toBe('string');
      expect(titleChoice.get('editionId')).not.toBe(editionId);
      expect(titleChoice.get('matchMethod')).toBe('catalog-choice');
      const mintedEdition = await db.doc(`editions/${titleChoice.get('editionId')}`).get();
      expect(mintedEdition.get('workId')).toBe(workId);
      expect(mintedEdition.get('createdBy')).toBe(normalUid);
      expect(mintedEdition.get('title')).toBe('Left Hand of Darkness');
      expect(mintedEdition.get('suggestedPageCount')).toBe(320);

      await openNewBook(page);
      await page.getByLabel('Author', {exact: true}).fill(newAuthorName);
      await page.getByLabel('Author', {exact: true}).press('Enter');
      await page.getByLabel('Book title', {exact: true}).fill('A Newly Shared Author Test');
      await page.getByLabel("Your edition's page count", {exact: true}).fill('123');
      await context.setOffline(true);
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      await expect(page.getByRole('dialog', {name: 'Add new book'})).toBeVisible();
      await expect(page.getByText('Connect to create a new shared author, then try again.')).toBeVisible();
      expect((await db.collection(`users/${normalUid}/books`)
        .where('title', '==', 'A Newly Shared Author Test').get()).empty).toBe(true);

      await context.setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
      await page.getByRole('button', {name: 'Add book', exact: true}).click();
      await expect(page.getByRole('dialog', {name: 'Add new book'})).toHaveCount(0);
      const expectedAuthorId = catalogAuthorId(newAuthorKey);
      await waitForDocument(db, `catalogAuthors/${expectedAuthorId}`, true);
      const createdAuthor = await db.doc(`catalogAuthors/${expectedAuthorId}`).get();
      expect(createdAuthor.get('canonicalName')).toBe(newAuthorName);
      expect(createdAuthor.get('createdBy')).toBe(normalUid);
      const createdBook = await waitForBookByTitle(db, normalUid, 'A Newly Shared Author Test');
      expect(createdBook.get('authorIds')).toEqual([expectedAuthorId]);
    } finally {
      await context.close();
    }
  });

  test('admin gate, bounded sections, recent-auth retry, apply, and stale-preview errors work in-browser', async ({browser}) => {
    const nonAdminContext: BrowserContext = await browser.newContext();
    const nonAdminPage = await nonAdminContext.newPage();
    await login(nonAdminPage, normalEmail);
    await navigateInApp(nonAdminPage, '/admin');
    await expect(nonAdminPage.getByText('Not Found')).toBeVisible();
    await nonAdminContext.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page, adminEmail);
      await navigateInApp(page, '/admin');
      await expect(page.getByRole('heading', {name: 'Catalog', exact: true})).toBeVisible();
      await expect(page.getByText(/^Live · /)).toBeVisible();
      // One tab at a time; the tab, search, filters and page live in the
      // URL, so the browser's back button steps through them.
      const sections = page.getByRole('navigation', {name: 'Catalog sections'});
      await expect(page.getByRole('heading', {name: /^Works/})).toBeVisible();
      await sections.getByRole('link', {name: /^Authors/}).click();
      await expect(page).toHaveURL(/\/admin\?tab=authors$/);
      await expect(page.getByRole('heading', {name: /^Authors/})).toBeVisible();
      await sections.getByRole('link', {name: /^Unmatched books/}).click();
      await expect(page.getByRole('heading', {name: /Unmatched books/})).toBeVisible();
      await sections.getByRole('link', {name: /^Findings/}).click();
      await expect(page.getByRole('heading', {name: /Same book, split across records/})).toBeVisible();
      await expect(page.getByRole('heading', {name: /Review findings/})).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/tab=books$/);
      await sections.getByRole('link', {name: /^Works/}).click();
      await expect(page).toHaveURL(/\/admin$/);

      // The work list filters as you type and the search lands in the URL;
      // a row opens the work's own page.
      await page.getByLabel('Filter works').fill('left hand darkness');
      await expect(page).toHaveURL(/q=left\+hand\+darkness/);
      const row = page.getByRole('row').filter({hasText: workId});
      await expect(row).toHaveCount(1);
      // The seeded work has never been reviewed, so it is in the queue.
      await expect(row.getByText('needs review')).toBeVisible();
      await row.getByRole('link', {name: 'The Left Hand of Darkness'}).click();
      await expect(page).toHaveURL(new RegExp(`/admin/works/${workId}$`));
      await expect(page.getByRole('heading', {name: 'The Left Hand of Darkness'})).toBeVisible();
      await expect(page.getByRole('heading', {name: /^Editions/})).toBeVisible();
      await expect(page.getByRole('heading', {name: /Readers' books/})).toBeVisible();

      // The author link opens the author's page, which lists this work;
      // back returns to the work page rather than to a scrolled list.
      await page.getByRole('link', {name: 'Ursula K. Le Guin'}).first().click();
      await expect(page).toHaveURL(new RegExp(`/admin/authors/${leGuinAuthorId}$`));
      await expect(page.getByRole('heading', {name: 'Ursula K. Le Guin'})).toBeVisible();
      await expect(page.getByRole('row').filter({hasText: workId})).toHaveCount(1);
      await expect(page.getByRole('button', {name: 'Edit author…'})).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/admin/works/${workId}$`));

      // Edit opens the operation dialog in place; the preview lists the exact changes.
      await page.getByRole('button', {name: 'Edit work…'}).click();
      const dialog = page.getByRole('dialog', {name: 'Edit work'});
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Alternate titles, one per line').fill('Left Hand');
      await dialog.getByRole('button', {name: 'Preview without applying'}).click();
      await expect(dialog.getByRole('heading', {name: 'Exact preview'})).toBeVisible();
      await expect(dialog.getByText('Before', {exact: true}).first()).toBeVisible();
      await expect(dialog.getByText('After', {exact: true}).first()).toBeVisible();

      await dialog.getByLabel('Alternate titles, one per line').fill('Left Hand\nDraft changed');
      await expect(dialog.getByRole('button', {name: 'Apply these exact changes'})).toHaveCount(0);
      await expect(dialog.getByText('The draft changed. Create a fresh preview before applying.')).toBeVisible();
      await dialog.getByRole('button', {name: 'Preview without applying'}).click();
      await expect(dialog.getByRole('heading', {name: 'Exact preview'})).toBeVisible();

      await agePersistedAuthSession(context, page, ADMIN_UID, adminEmail);
      page.once('dialog', (confirmation) => confirmation.accept());
      await dialog.getByRole('button', {name: 'Apply these exact changes'}).click();
      await expect(page.getByRole('heading', {name: 'Confirm recent authentication'})).toBeVisible();
      await expect(page.getByLabel('Administrator password')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', {name: 'Confirm recent authentication'})).toHaveCount(0);
      await expect(dialog.getByRole('button', {name: 'Apply these exact changes'})).toBeFocused();

      page.once('dialog', (confirmation) => confirmation.accept());
      await dialog.getByRole('button', {name: 'Apply these exact changes'}).click();
      await expect(page.getByRole('heading', {name: 'Confirm recent authentication'})).toBeVisible();
      await page.getByLabel('Administrator password').fill(PASSWORD);
      await page.getByRole('button', {name: 'Reauthenticate and retry'}).click();
      // A landed apply closes the dialog; the page reports it and the live
      // listener shows the new alias without a reload.
      await expect(page.getByText(/Applied .* documents changed/)).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Left Hand · Draft changed')).toBeVisible();

      // A preview goes stale when the document changes underneath it.
      await page.getByRole('button', {name: 'Edit work…'}).click();
      await dialog.getByLabel('Alternate titles, one per line').fill('Left Hand\nThe Left Hand');
      await dialog.getByRole('button', {name: 'Preview without applying'}).click();
      await expect(dialog.getByRole('heading', {name: 'Exact preview'})).toBeVisible();
      await db.doc(`works/${workId}`).update({subjects: ['Concurrent correction'], updatedAt: FieldValue.serverTimestamp()});
      page.once('dialog', (confirmation) => confirmation.accept());
      await dialog.getByRole('button', {name: 'Apply these exact changes'}).click();
      await expect(dialog.getByRole('alert')).toContainText('preview is stale');
      await dialog.getByRole('button', {name: 'Cancel'}).click();
      await expect(dialog).toBeHidden();

      // A review mark lands at once and takes the work out of the queue;
      // the queue is a filter in the URL, so it can be opened directly.
      await page.getByRole('button', {name: 'Mark reviewed'}).click();
      await expect(page.getByText(/^reviewed \d{4}-\d{2}-\d{2}$/)).toBeVisible();
      await expect(page.getByRole('button', {name: 'Mark unreviewed'})).toBeVisible();
      await navigateInApp(page, '/admin');
      await page.getByRole('link', {name: /^Needs review/}).click();
      await expect(page).toHaveURL(/review=needs$/);
      await expect(page.getByRole('row').filter({hasText: workId})).toHaveCount(0);
      await page.getByRole('link', {name: 'Reviewed', exact: true}).click();
      await expect(page).toHaveURL(/review=done$/);
      await expect(page.getByRole('row').filter({hasText: workId})).toHaveCount(1);
      await navigateInApp(page, `/admin/works/${workId}`);

      // The edition the title-only save minted is listed with its reader's
      // email as creator, beside the seeded one.
      await expect(page.getByRole('row').filter({hasText: 'Left Hand of Darkness edition'})).toHaveCount(0);
      await expect(page.getByRole('cell', {name: normalEmail})).toBeVisible();

      // Two records of one edition merge: the reader's bare minted edition
      // becomes an alias of the seeded one, the reader's book moves to the
      // survivor and inherits the ISBN, cover and publisher it left blank,
      // while its own page count stays.
      await page.getByRole('row').filter({hasText: normalEmail}).getByRole('button', {name: 'Merge into…', exact: true}).click();
      const mergeDialog = page.getByRole('dialog', {name: 'Merge editions'});
      await expect(mergeDialog).toBeVisible();
      await mergeDialog.getByLabel('Surviving edition').selectOption(editionId);
      await mergeDialog.getByRole('button', {name: 'Preview without applying'}).click();
      await expect(mergeDialog.getByRole('heading', {name: 'Exact preview'})).toBeVisible();
      await expect(mergeDialog.getByText(`"isbn": "${isbn}"`)).toBeVisible();
      page.once('dialog', (confirmation) => confirmation.accept());
      await mergeDialog.getByRole('button', {name: 'Apply these exact changes'}).click();
      await expect(page.getByText(/Applied .* documents changed/)).toBeVisible();
      await expect(mergeDialog).toBeHidden();
      await expect(page.getByRole('heading', {name: 'Absorbed editions'})).toBeVisible();
      await expect(page.getByRole('row').filter({hasText: normalEmail})).toHaveCount(0);
      const mergedBook = await waitForBookByTitle(db, normalUid, 'Left Hand of Darkness');
      expect(mergedBook.get('editionId')).toBe(editionId);
      expect(mergedBook.get('matchMethod')).toBe('admin');
      expect(mergedBook.get('isbn')).toBe(isbn);
      // The add-book flow had already given the book the work's cover, and a
      // value the reader has is never replaced; the blank publisher fills.
      expect(mergedBook.get('coverUrl')).toBe('https://example.test/work-cover.jpg');
      expect(mergedBook.get('publisher')).toBe('Ace');
      expect(mergedBook.get('pageCount')).toBe(320);

      // Every operation that starts from this work opens as its own dialog;
      // the per-edition buttons appear once per edition, so the first is used.
      for (const [button, title] of [
        ['Hide…', 'Edit work'], ['Merge into another work…', 'Merge works'],
        ['New edition…', 'Create or edit edition'], ['Edit edition…', 'Create or edit edition'],
        ['Repoint ISBN…', 'Repoint ISBN'],
      ]) {
        await page.getByRole('button', {name: button, exact: true}).first().click();
        const opened = page.getByRole('dialog', {name: title});
        await expect(opened.getByRole('button', {name: 'Preview without applying'})).toBeVisible();
        await opened.getByRole('button', {name: 'Cancel'}).click();
        await expect(opened).toBeHidden();
      }

      // And the record-less operations from the overview.
      await navigateInApp(page, '/admin');
      for (const [button, title] of [
        ['New author…', 'New author'], ['New work…', 'New work'],
        ['New edition…', 'Create or edit edition'], ['Repoint an ISBN…', 'Repoint ISBN'],
        ['Merge works…', 'Merge works'], ['Merge authors…', 'Merge authors'],
      ]) {
        await page.getByRole('button', {name: button, exact: true}).click();
        const opened = page.getByRole('dialog', {name: title});
        await expect(opened.getByRole('button', {name: 'Preview without applying'})).toBeVisible();
        await opened.getByRole('button', {name: 'Cancel'}).click();
        await expect(opened).toBeHidden();
      }
    } finally {
      await context.close();
    }
  });
});
