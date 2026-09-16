// The to-read plan through the Auth and Firestore emulators: a reader with
// two books in progress and two weeks of sessions sees both books queued
// with dates, plans a title-only book below them, reorders by keyboard
// (persisted as ranks), sets a pace estimate, applies a daily scenario, and
// starts the planned book, which becomes a personal book with the same id.
import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = 'book-tracker-d8f24';
const PASSWORD = 'valid-test-password';

function requireLocalEmulators(): void {
  if (!/^(?:127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('To-read browser tests require the local Firestore emulator.');
  }
  if (!/^(?:127\.0\.0\.1|localhost):9099$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) {
    throw new Error('To-read browser tests require the local Auth emulator.');
  }
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not converge.`);
}

test.describe.serial('to-read plan through the emulators', () => {
  const suffix = randomUUID();
  const uid = `plan-user-${suffix}`;
  const email = `${uid}@example.test`;
  const app = initializeApp({ projectId: PROJECT_ID }, `to-read-e2e-${suffix}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const userRef = db.doc(`users/${uid}`);
  const entries = () => db.collection(`users/${uid}/readingPlanEntries`);
  const rowTitles = (page: Page) => page.getByTestId('plan-row').locator('.title').allTextContents();

  test.beforeAll(async () => {
    requireLocalEmulators();
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true });
    await userRef.set({ uid, email });
    const now = Timestamp.now();
    // Two books in progress: A was read most recently, so the Reading list
    // (and the initial queue) puts it first.
    const book = (id: string, title: string, currentPage: number, lastReadMillis: number) => ({
      owner: userRef, authorIds: [], title, activeTimer: null,
      currentPage, currentPageUpdateId: null, pageCount: 300, finished: false, finishedAt: null,
      pagesRead: currentPage, timeRead: currentPage * 2,
      lastReadAt: Timestamp.fromMillis(lastReadMillis),
      isbn: '', coverUrl: '', publisher: '', publishedDate: '', subjects: [], fiction: true, language: '',
      workId: null, editionId: null, matchMethod: null, linkedAt: null, createdAt: now, updatedAt: now,
    });
    const dayMs = 24 * 60 * 60 * 1000;
    const today = Date.now();
    await userRef.collection('books').doc('book-a').set(book('book-a', 'Alpha in progress', 100, today - dayMs));
    await userRef.collection('books').doc('book-b').set(book('book-b', 'Beta in progress', 50, today - 2 * dayMs));
    // 60 minutes on each of the previous seven days: a 30 min/day budget.
    for (let day = 1; day <= 7; day += 1) {
      const at = Timestamp.fromMillis(today - day * dayMs);
      await userRef.collection('books').doc('book-a').collection('updates').doc(`session-${day}`).set({
        owner: userRef, book: userRef.collection('books').doc('book-a'), type: 'reading',
        fromPage: 0, toPage: 10, pagesRead: 10, timeRead: 60, createdAt: at, updatedAt: at,
      });
    }
  });

  test.afterAll(async () => {
    await deleteApp(app);
  });

  test('books in progress are queued with a forecast and a planned book lands below them', async ({ page }) => {
    await login(page, email);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'To read' }).click();
    await expect(page).toHaveURL(/\/to-read$/);
    await expect(page.getByTestId('plan-row')).toHaveCount(2);
    expect(await rowTitles(page)).toEqual(['Alpha in progress', 'Beta in progress']);
    await expect(page.getByTestId('plan-summary')).toContainText('30 min');
    await expect(page.getByTestId('plan-headline')).toContainText('At 30 minutes a day');
    // Both rows are new to the plan: nothing has been positioned yet.
    await expect(page.getByText('New to your plan')).toHaveCount(2);

    await page.getByRole('button', { name: '+ Add to plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to plan' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Book title').fill('Gamma planned');
    await dialog.getByRole('button', { name: 'Add to plan', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('plan-row')).toHaveCount(3);
    expect(await rowTitles(page)).toEqual(['Alpha in progress', 'Beta in progress', 'Gamma planned']);
    // The two books in progress were positioned in the same batch, below
    // nothing and above the new intention.
    const saved = await waitFor(async () => (await entries().get()).docs, (docs) => docs.length === 3, 'plan entries');
    const ranks = Object.fromEntries(saved.map((doc) => [doc.data().kind === 'planned' ? 'planned' : doc.id, doc.data().rank as number]));
    expect(ranks['book-a']).toBeLessThan(ranks['book-b']);
    expect(ranks['book-b']).toBeLessThan(ranks.planned);
    // A title-only intention has no dates; the summary says what is missing.
    await expect(page.getByTestId('plan-row').nth(2)).toContainText('Unknown effort');
    await expect(page.getByTestId('plan-summary')).toContainText('1 book needs a page count or pace');
    // Reading counts are untouched: the Reading list still shows two books.
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Reading' }).click();
    await expect(page.getByTestId('reading-summary')).toContainText('2 books');
  });

  test('keyboard reorder persists one rank and announces the move', async ({ page }) => {
    await login(page, email);
    await page.goto('/to-read');
    await expect(page.getByTestId('plan-row')).toHaveCount(3);
    const handle = page.getByRole('button', { name: /^Reorder Gamma planned/ });
    await handle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await rowTitles(page)).toEqual(['Gamma planned', 'Alpha in progress', 'Beta in progress']);
    await expect(page.getByTestId('plan-announcement')).toContainText('Gamma planned moved to position 1 of 3');
    await expect(page.getByRole('button', { name: /^Reorder Gamma planned/ })).toBeFocused();
    const saved = await waitFor(async () => (await entries().get()).docs, (docs) => {
      const planned = docs.find((doc) => doc.data().kind === 'planned');
      const a = docs.find((doc) => doc.id === 'book-a');
      return planned !== undefined && a !== undefined && (planned.data().rank as number) < (a.data().rank as number);
    }, 'reordered ranks');
    expect(saved).toHaveLength(3);
    // Reload: the order survives.
    await page.reload();
    await expect(page.getByTestId('plan-row')).toHaveCount(3);
    expect(await rowTitles(page)).toEqual(['Gamma planned', 'Alpha in progress', 'Beta in progress']);
  });

  test('a manual estimate gives a planned book dates, a scenario replaces the budget, and Start reading converts it', async ({ page }) => {
    await login(page, email);
    await page.goto('/to-read');
    const first = page.getByTestId('plan-row').first();
    await expect(first).toContainText('Gamma planned');
    await first.getByRole('button', { name: 'Details' }).click();
    await first.getByRole('button', { name: 'Set my estimate' }).click();
    const estimate = page.getByRole('dialog', { name: 'Your estimate' });
    await estimate.getByLabel(/Minutes per page/).fill('2');
    await estimate.getByRole('button', { name: 'Save estimate' }).click();
    await expect(estimate).toBeHidden();
    // Still no page count: the estimate alone cannot produce dates.
    await expect(first).toContainText('Page count needed');
    await first.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit planned book' });
    await edit.getByLabel('Page count (optional)').fill('150');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    // 150 pages at 2 min/page = 5 hours, at 30 minutes a day: ten days.
    await expect(first).toContainText('5h 0m left');
    await expect(first).toContainText('Your estimate');
    const expected = new Date();
    expected.setDate(expected.getDate() + 9);
    await expect(first.locator('.finish .value')).toHaveText(expected.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));

    // A scenario of 60 minutes a day halves that: the fifth day from today.
    await page.getByLabel('Plan with').fill('60');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('plan-summary')).toContainText('Your scenario');
    await expect(page.getByTestId('plan-headline')).toContainText('At 60 minutes a day');
    const settings = await waitFor(async () => (await db.doc(`users/${uid}/readingPlans/default`).get()).data(), (data) => data?.dailyMinutesOverride === 60, 'scenario');
    expect(settings?.dailyMinutesOverride).toBe(60);

    // Start reading: a personal book with the entry's id, no session, and
    // the entry converted in place with its rank intact.
    const before = await entries().get();
    const planned = before.docs.find((doc) => doc.data().kind === 'planned');
    if (planned === undefined) throw new Error('No planned entry to start.');
    // The details panel opened above stays open across the dialogs.
    await first.getByRole('button', { name: 'Start reading' }).click();
    const start = page.getByRole('dialog', { name: 'Start reading' });
    await expect(start.getByLabel("Your edition's page count")).toHaveValue('150');
    await start.getByRole('button', { name: 'Start reading' }).click();
    await expect(start).toBeHidden();
    const book = await waitFor(async () => (await userRef.collection('books').doc(planned.id).get()).data(), (data) => data !== undefined, 'started book');
    expect(book?.title).toBe('Gamma planned');
    expect(book?.pageCount).toBe(150);
    expect(book?.currentPage).toBe(0);
    expect(book?.timeRead).toBe(0);
    const converted = await waitFor(async () => (await entries().doc(planned.id).get()).data(), (data) => data?.kind === 'book', 'converted entry');
    expect(converted?.rank).toBe(planned.data().rank);
    expect(converted?.manualMinutesPerPage).toBe(2);
    expect(converted?.title).toBeUndefined();
    await expect(first).toContainText('Reading');
    expect(await rowTitles(page)).toEqual(['Gamma planned', 'Alpha in progress', 'Beta in progress']);
    await page.screenshot({ path: 'test-results/to-read-plan.png', fullPage: true });
  });
});
