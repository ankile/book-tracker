import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import type { User } from 'firebase/auth';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const PROJECT_ID = 'book-tracker-d8f24';
const TEST_PASSWORD = 'valid-test-password';

function requireLocalEmulators(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!/^(?:127\.0\.0\.1|localhost):8080$/.test(firestoreHost ?? '')) {
    throw new Error(`Expected the local Firestore emulator, got ${firestoreHost ?? 'unset'}`);
  }
  if (!/^(?:127\.0\.0\.1|localhost):9099$/.test(authHost ?? '')) {
    throw new Error(`Expected the local Auth emulator, got ${authHost ?? 'unset'}`);
  }
}

function capturePermissionErrors(page: Page, errors: string[]): void {
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/permission-denied|false for 'list'/i.test(text)) errors.push(text);
  });
}

test('a live book and author listener survives reloading the original tab', async ({ browser }) => {
  requireLocalEmulators();

  const suffix = randomUUID();
  const uid = `multitab-${suffix}`;
  const email = `${uid}@example.test`;
  const authorId = `author-${suffix}`;
  const bookId = `book-${suffix}`;
  const initialAuthor = `Initial Author ${suffix}`;
  const updatedAuthor = `Updated Author ${suffix}`;
  const initialTitle = `Initial Book ${suffix}`;
  const updatedTitle = `Updated Book ${suffix}`;
  const adminApp = initializeApp({ projectId: PROJECT_ID }, `multitab-${suffix}`);
  const auth = getAuth(adminApp);
  const db = getFirestore(adminApp);
  const userRef = db.doc(`users/${uid}`);
  const authorRef = userRef.collection('authors').doc(authorId);
  const bookRef = userRef.collection('books').doc(bookId);

  await auth.createUser({ uid, email, password: TEST_PASSWORD });
  await userRef.set({ uid, email });
  await authorRef.set({
    name: initialAuthor,
    nameLower: initialAuthor.toLowerCase(),
    kind: 'entity',
    updatedAt: Timestamp.now(),
  });
  await bookRef.set({
    owner: userRef,
    authorIds: [authorId],
    title: initialTitle,
    activeTimer: null,
    currentPage: 10,
    currentPageUpdateId: null,
    pageCount: 100,
    finished: false,
    pagesRead: 10,
    timeRead: 20,
    isbn: '',
    coverUrl: '',
    publisher: '',
    publishedDate: '',
    subjects: [],
    fiction: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  const context = await browser.newContext();
  const permissionErrors: string[] = [];
  const first = await context.newPage();
  capturePermissionErrors(first, permissionErrors);

  try {
    await first.goto('/');
    await first.getByLabel('Email address', { exact: true }).fill(email);
    await first.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await first.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(first.getByText(initialTitle, { exact: true })).toBeVisible();
    await expect(first.getByText(`${initialAuthor}:`, { exact: true })).toBeVisible();

    await first.evaluate(async ({ appAuthPath, firebaseAuthPath }) => {
      const [{ auth }, { indexedDBLocalPersistence, onAuthStateChanged, setPersistence }] = await Promise.all([
        import(appAuthPath),
        import(firebaseAuthPath),
      ]);
      const state = globalThis as typeof globalThis & { __e2eAuthStates?: Array<string | null> };
      state.__e2eAuthStates = [];
      onAuthStateChanged(auth, (user: User | null) => state.__e2eAuthStates?.push(user?.uid ?? null));
      await setPersistence(auth, indexedDBLocalPersistence);
    }, {
      appAuthPath: '/src/lib/firebase/auth.ts',
      firebaseAuthPath: '/node_modules/.vite/deps/firebase_auth.js',
    });

    const second = await context.newPage();
    capturePermissionErrors(second, permissionErrors);
    await second.goto('/');
    await expect(second.getByText(initialTitle, { exact: true })).toBeVisible();
    await expect(second.getByText(`${initialAuthor}:`, { exact: true })).toBeVisible();
    expect(await first.evaluate(() => (
      globalThis as typeof globalThis & { __e2eAuthStates?: Array<string | null> }
    ).__e2eAuthStates)).not.toContain(null);

    // Reload the original Firestore primary while another same-origin tab is
    // alive. A startup setPersistence call can transiently remove the shared
    // Auth user; the surviving tab then runs this tab's shared targets without
    // credentials and permanently rejects their onSnapshot listeners.
    await first.reload();
    await expect(first.getByText(initialTitle, { exact: true })).toBeVisible();

    await db.runTransaction(async (transaction) => {
      transaction.update(bookRef, { title: updatedTitle, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(authorRef, {
        name: updatedAuthor,
        nameLower: updatedAuthor.toLowerCase(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    // The second tab proves the emulator mutation landed. Requiring the
    // reloaded tab to observe the same sentinel changes proves its listeners
    // are live; merely rendering IndexedDB's cached initial rows cannot pass.
    await expect(second.getByText(updatedTitle, { exact: true })).toBeVisible();
    await expect(second.getByText(`${updatedAuthor}:`, { exact: true })).toBeVisible();
    await expect(first.getByText(updatedTitle, { exact: true })).toBeVisible();
    await expect(first.getByText(`${updatedAuthor}:`, { exact: true })).toBeVisible();
    await expect(first.getByText(/Couldn't load .+ \(permission-denied\)\./)).toHaveCount(0);
    expect(permissionErrors).toEqual([]);
  } finally {
    await context.close();
    await db.recursiveDelete(userRef);
    await auth.deleteUser(uid);
    await deleteApp(adminApp);
  }
});
