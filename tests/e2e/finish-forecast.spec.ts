import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { expect, test } from '@playwright/test';

test('finish forecasts open from Est left, handle pauses, and update from local sessions', async ({ page }) => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080'
      || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
    throw new Error('This test requires both loopback emulators');
  }
  const now = Date.now();
  const day = 86_400_000;
  const uid = `forecast-${randomUUID()}`;
  const app = initializeApp({ projectId: 'book-tracker-d8f24' }, uid);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const email = `${uid}@example.test`;
  const password = 'local-forecast-test-only';
  await auth.createUser({ uid, email, password, emailVerified: true });
  const owner = db.doc(`users/${uid}`);
  await owner.set({ uid, email });
  const author = db.doc(`catalogAuthors/${uid}`);
  await author.set({ canonicalName: 'Forecast Author', alternateNames: [], nameKeys: ['forecast author'],
    sortName: 'Forecast Author', kind: 'entity', status: 'active', mergedFrom: [],
    createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  for (const [id, title, ages] of [
    ['active', 'Active forecast book', [10, 2]],
    ['paused', 'Paused forecast book', [100, 90]],
    ['new', 'New forecast book', []],
  ] as const) {
    const book = owner.collection('books').doc(id);
    await book.set({ owner, authorIds: [author.id], title, activeTimer: null, currentPage: ages.length * 20,
      currentPageUpdateId: null, pageCount: 200, finished: false, finishedAt: null,
      pagesRead: ages.length * 20, timeRead: ages.length * 30, isbn: '', coverUrl: '', publisher: '',
      publishedDate: '', subjects: [], fiction: null, createdAt: Timestamp.fromMillis(now - 110 * day), updatedAt: Timestamp.now() });
    for (const [i, age] of ages.entries()) {
      await book.collection('updates').doc(`session-${i}`).set({ owner, book, type: 'reading',
        fromPage: i * 20, toPage: (i + 1) * 20, pagesRead: 20, timeRead: 30,
        createdAt: Timestamp.fromMillis(now - age * day), updatedAt: Timestamp.fromMillis(now - age * day) });
    }
  }
  const externalFirebase: string[] = [];
  await page.route(/https:\/\/[^/]*(?:googleapis\.com|cloudfunctions\.net)\//, async (route) => {
    externalFirebase.push(route.request().url());
    await route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'View estimated finish for Active forecast book', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Estimated finish', exact: true });
  await expect(dialog.getByTestId('finish-date')).toBeVisible();
  await expect(dialog.getByText("There isn't enough history yet to estimate a date range.")).toBeVisible();
  const oldDate = await dialog.getByTestId('finish-date').textContent();
  const active = owner.collection('books').doc('active');
  const batch = db.batch();
  batch.set(active.collection('updates').doc('session-new'), { owner, book: active, type: 'reading',
    fromPage: 40, toPage: 180, pagesRead: 140, timeRead: 90, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  batch.update(active, { currentPage: 180, pagesRead: 180, timeRead: 150, updatedAt: Timestamp.now() });
  await batch.commit();
  await expect(dialog.getByTestId('finish-date')).not.toHaveText(oldDate!);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'View estimated finish for Paused forecast book', exact: true }).click();
  await expect(dialog.getByText('No reliable finish date yet')).toBeVisible();
  const card = dialog.locator('form');
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'View estimated finish for New forecast book', exact: true }).click();
  await expect(dialog.getByText('A little more reading first')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'View reading sessions for Active forecast book', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Reading sessions/i })).toBeVisible();
  expect(externalFirebase).toEqual([]);
  await db.recursiveDelete(owner);
  await author.delete();
  await auth.deleteUser(uid);
  await deleteApp(app);
});
