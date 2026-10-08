// Words per minute through the Auth, Firestore and Functions emulators: a
// reader with two finished books of one work, on two editions Word Counter
// measured. Only the book whose page count matches its edition's measured
// page count reads in words, on the stats page and on the work page. A third,
// unread book on another measured edition gets its time left in words.
import { createHash, randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = 'book-tracker-d8f24';
const PASSWORD = 'valid-test-password';

function requireLocalEmulators(): void {
  if (!/^(?:127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('Word-speed browser tests require the local Firestore emulator.');
  }
  if (!/^(?:127\.0\.0\.1|localhost):9099$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) {
    throw new Error('Word-speed browser tests require the local Auth emulator.');
  }
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

const wordEstimate = (pageCountBasis: number, wordsPerPage: number) => ({
  method: 'random-pages', countingVersion: 1, pageCountBasis, chosenPages: 0, randomPages: 16,
  ordinaryShare: 0.9, wordsPerPage, wordsPerPageLow: wordsPerPage - 30, wordsPerPageHigh: wordsPerPage + 30,
  language: 'en', readability: null, vocabulary: null,
  createdBy: 'word-counter-reader', measuredAt: Timestamp.now(),
});

test.describe.serial('words per minute through the emulators', () => {
  const suffix = randomUUID();
  const uid = `word-speed-${suffix}`;
  const email = `${uid}@example.test`;
  const workId = `word-work-${suffix}`;
  const authorId = `word-author-${suffix}`;
  const app = initializeApp({ projectId: PROJECT_ID }, `word-speed-e2e-${suffix}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const userRef = db.doc(`users/${uid}`);

  test.beforeAll(async () => {
    requireLocalEmulators();
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true });
    const now = Timestamp.now();
    const dayMs = 24 * 60 * 60 * 1000;
    await Promise.all([
      userRef.set({ uid, email }),
      db.doc(`users/${uid}/settings/bookSharing`).set({
        enabled: true, timeZone: 'UTC', createdAt: now, updatedAt: now,
      }),
      db.doc(`catalogAuthors/${authorId}`).set({
        canonicalName: 'Measured Author', alternateNames: [], nameKeys: ['measured author'],
        sortName: 'Author', kind: 'person', status: 'active', mergedFrom: [], createdAt: now, updatedAt: now,
      }),
      db.doc(`works/${workId}`).set({
        canonicalTitle: 'Measured Work', alternateTitles: [], titleKeys: ['measured work'],
        authorIds: [authorId], coverUrl: '', subjects: [], fiction: true, language: 'en',
        status: 'active', mergedFrom: [], createdAt: now, updatedAt: now,
      }),
      // Measured on 300 pages at 250 words a page.
      db.doc(`editions/matched-${suffix}`).set({
        workId, isbn13: null, title: 'Measured Work', publisher: '', publishedDate: '', language: '',
        translatorNames: [], format: 'full', suggestedPageCount: 300, coverUrl: '', externalIds: {},
        createdAt: now, updatedAt: now, wordEstimate: wordEstimate(300, 250),
      }),
      // Another work, measured on 200 pages at 400 words a page: the unread book.
      db.doc(`works/unread-work-${suffix}`).set({
        canonicalTitle: 'Unread Work', alternateTitles: [], titleKeys: ['unread work'],
        authorIds: [authorId], coverUrl: '', subjects: [], fiction: true, language: 'en',
        status: 'active', mergedFrom: [], createdAt: now, updatedAt: now,
      }),
      db.doc(`editions/unread-${suffix}`).set({
        workId: `unread-work-${suffix}`, isbn13: null, title: 'Unread Work', publisher: '', publishedDate: '',
        language: '', translatorNames: [], format: 'full', suggestedPageCount: 200, coverUrl: '', externalIds: {},
        createdAt: now, updatedAt: now, wordEstimate: wordEstimate(200, 400),
      }),
      // Measured on 400 pages; the reader's copy has 350.
      db.doc(`editions/other-printing-${suffix}`).set({
        workId, isbn13: null, title: 'Measured Work', publisher: '', publishedDate: '', language: '',
        translatorNames: [], format: 'full', suggestedPageCount: 400, coverUrl: '', externalIds: {},
        createdAt: now, updatedAt: now, wordEstimate: wordEstimate(400, 320),
      }),
    ]);
    const book = (id: string, title: string, editionId: string, pageCount: number, minutes: number) => ({
      owner: userRef, authorIds: [authorId], title, activeTimer: null,
      currentPage: pageCount, currentPageUpdateId: null, pageCount, finished: true,
      finishedAt: Timestamp.fromMillis(Date.now() - 10 * dayMs), pagesRead: pageCount, timeRead: minutes,
      lastReadAt: Timestamp.fromMillis(Date.now() - 10 * dayMs),
      isbn: '', coverUrl: '', publisher: '', publishedDate: '', subjects: [], fiction: true, language: 'en',
      workId, editionId, matchMethod: 'catalog-choice', linkedAt: now, createdAt: now, updatedAt: now,
    });
    const books = [
      // 300 pages in 6 hours at 250 words a page: ≈ 208 words a minute.
      { id: 'matched', title: 'Matched Copy', editionId: `matched-${suffix}`, pageCount: 300, minutes: 360 },
      { id: 'other', title: 'Other Printing Copy', editionId: `other-printing-${suffix}`, pageCount: 350, minutes: 300 },
    ];
    for (const { id, title, editionId, pageCount, minutes } of books) {
      const bookRef = userRef.collection('books').doc(id);
      await bookRef.set(book(id, title, editionId, pageCount, minutes));
      // Two sessions a month apart, so the monthly speed chart has two points.
      for (const [index, daysAgo] of [70, 40].entries()) {
        const at = Timestamp.fromMillis(Date.now() - daysAgo * dayMs);
        await bookRef.collection('updates').doc(`session-${index}`).set({
          owner: userRef, book: bookRef, type: 'reading',
          fromPage: index * pageCount / 2, toPage: (index + 1) * pageCount / 2,
          pagesRead: pageCount / 2, timeRead: minutes / 2, createdAt: at, updatedAt: at,
        });
      }
    }
    await userRef.collection('books').doc('unread').set({
      ...book('unread', 'Unread Measured Copy', `unread-${suffix}`, 200, 0),
      workId: `unread-work-${suffix}`, currentPage: 0, pagesRead: 0, finished: false, finishedAt: null,
      lastReadAt: null,
    });
    // The sharing projection trigger indexes the reader under the work.
    const projection = `sharedWorkOwners/${createHash('sha256').update(`${workId}\0${uid}`).digest('hex')}`;
    for (let attempt = 0; attempt < 100 && !(await db.doc(projection).get()).exists; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await db.doc(projection).get()).exists).toBe(true);
  });

  test.afterAll(async () => {
    await deleteApp(app);
  });

  test('the stats page reads the measured copy in words per minute and leaves the other printing out', async ({ page }) => {
    await login(page, email);
    await page.goto('/me');
    const words = page.locator('.words');
    await expect(words.getByRole('heading', { name: 'Words per minute' })).toBeVisible();
    await expect(words.locator('.pooled')).toContainText('≈ 208 wpm');
    await expect(words.locator('.pooled')).toContainText('(183–233) across 1 measured book');
    await expect(words.getByRole('listitem')).toHaveCount(1);
    await expect(words.getByRole('listitem')).toContainText('Matched Copy');
    await expect(words.getByRole('listitem')).toContainText('250 words/page · 6 hrs');
    // The fastest-reads row carries the same figure; the other printing has none.
    const fastest = page.locator('.book-lists').getByRole('listitem');
    await expect(fastest.filter({ hasText: 'Matched Copy' }).first()).toContainText('50 pages/hr · ≈ 208 wpm');
    await expect(fastest.filter({ hasText: 'Other Printing Copy' }).first()).not.toContainText('wpm');
    await page.locator('.words').screenshot({ path: test.info().outputPath('stats-words-per-minute.png') });
  });

  test('the work page gives words per minute for the matched attempt only', async ({ page }) => {
    await login(page, email);
    await page.goto(`/books/${workId}`);
    const attempts = page.locator('section.attempt');
    await expect(attempts).toHaveCount(2);
    const wordRows = page.locator('dt', { hasText: 'Words per minute' });
    await expect(wordRows).toHaveCount(1);
    await expect(wordRows.locator('xpath=following-sibling::dd')).toHaveText('≈ 208');
    await page.locator('.attempt-list').first().screenshot({ path: test.info().outputPath('work-words-per-minute.png') });
  });

  test('an unread measured book gets its time left in words', async ({ page }) => {
    await login(page, email);
    await page.goto('/');
    // The matched copy read 75,000 words in 360 minutes (0.0048 a word); the unread edition sets 400 words on
    // each of its 200 pages: 1.92 minutes a page, 384 minutes left. The author's pace in pages would say ~1.02.
    const paces = page.locator('.pace[title*="words per page"]');
    await expect(paces).toHaveCount(2);
    await expect(paces.first()).toHaveText('~06:24');
    await expect(paces.nth(1)).toHaveText('~1.92');
    await page.locator('.container').first().screenshot({ path: test.info().outputPath('reading-list-words.png') });
  });
});
