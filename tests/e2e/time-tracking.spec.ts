import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { test, expect } from "@playwright/test";

async function fixture(provider: "none" | "toggl") {
  if (
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099"
  )
    throw new Error("Local emulators required.");
  const uid = `timer-browser-${randomUUID()}`,
    email = `${uid}@example.test`,
    password = "local-browser-test-password";
  const app = initializeApp({ projectId: "book-tracker-d8f24" }, uid),
    db = getFirestore(app),
    auth = getAuth(app),
    user = db.doc(`users/${uid}`),
    book = user.collection("books").doc("reading");
  const revision = randomUUID();
  const connection =
    provider === "none"
      ? { provider, revision }
      : {
          provider,
          revision,
          accountId: "1",
          workspaceId: 123,
          projectId: 456,
        };
  await auth.createUser({ uid, email, password, emailVerified: true });
  await user.set({ uid, email, timeTracking: connection });
  await db
    .doc("configuration/timeTracking")
    .set({ threeggleEnabled: false, timerWriteVersion: 2 });
  await user
    .collection("timerLifecycle")
    .doc("current")
    .set({ version: 1, state: "idle", cleared: null });
  if (provider === "toggl")
    await getFirestore(app, "secrets")
      .doc(`timeTrackingTokens/${uid}/revisions/${revision}`)
      .set({ apiToken: "emulator-token" });
  const author = db.doc(`catalogAuthors/${uid}`);
  await author.set({
    canonicalName: "Timer Author",
    alternateNames: [],
    nameKeys: ["timer author"],
    sortName: "Timer Author",
    kind: "entity",
    status: "active",
    mergedFrom: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  await book.set({
    owner: user,
    authorIds: [uid],
    title: "Offline reading book",
    activeTimer: null,
    currentPage: 10,
    currentPageUpdateId: null,
    pageCount: 100,
    finished: false,
    pagesRead: 10,
    timeRead: 20,
    isbn: "",
    coverUrl: "",
    publisher: "",
    publishedDate: "",
    subjects: [],
    fiction: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  return {
    uid,
    email,
    password,
    db,
    user,
    book,
    cleanup: async () => {
      await db.recursiveDelete(user);
      await getFirestore(app, "secrets").recursiveDelete(
        getFirestore(app, "secrets").doc(`timeTrackingTokens/${uid}`),
      );
      await author.delete();
      await auth.deleteUser(uid);
      await db.doc("configuration/timeTracking").delete();
      await deleteApp(app);
    },
  };
}

for (const provider of ["none", "toggl"] as const)
  test(`${provider}: offline start/stop survives reload and leaves durable acknowledgements`, async ({
    page,
    context,
  }) => {
    const f = await fixture(provider);
    page.on("dialog", (dialog) => dialog.dismiss());
    try {
      await page.goto("/");
      await page.getByLabel("Email address", { exact: true }).fill(f.email);
      await page.getByLabel("Password", { exact: true }).fill(f.password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      const start = page.getByRole("button", {
        name: "Start a reading timer for Offline reading book",
        exact: true,
      });
      await expect(start).toBeEnabled();
      // Only the reading client goes offline; the real local Functions worker
      // remains available to receive the queued completed interval on reconnect.
      await context.setOffline(true);
      await start.click();
      await expect(
        page.getByRole("button", {
          name: "Stop the reading timer for Offline reading book",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Stop the reading timer for Offline reading book",
          exact: true,
        }),
      ).toContainText("0:02");
      await page
        .getByRole("button", {
          name: "Stop the reading timer for Offline reading book",
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(start).toBeVisible();
      await context.setOffline(false);
      await page.reload();
      await expect(start).toBeEnabled();
      await expect
        .poll(
          async () => (await f.user.collection("timerOperations").get()).size,
        )
        .toBe(2);
      expect((await f.book.get()).get("activeTimer")).toBeNull();
      const rows = await f.user.collection("timeTrackingQueue").get();
      if (provider === "none") expect(rows.size).toBe(0);
      else {
        expect(rows.size).toBe(1);
        await expect
          .poll(async () => (await rows.docs[0].ref.get()).get("status"))
          .toBe("synced");
      }
      const second = await context.newPage();
      await second.goto("/");
      await expect(
        second.getByRole("button", {
          name: "Start a reading timer for Offline reading book",
          exact: true,
        }),
      ).toBeEnabled();
      await page.reload();
      await expect(start).toBeEnabled();
      expect((await f.user.collection("timerOperations").get()).size).toBe(2);
      await second.close();
    } finally {
      await f.cleanup();
    }
  });

test("a rejected offline revision keeps its interval through reload and explicit sign-out review", async ({
  page,
  context,
}) => {
  const f = await fixture("none");
  try {
    await page.goto("/");
    await page.getByLabel("Email address", { exact: true }).fill(f.email);
    await page.getByLabel("Password", { exact: true }).fill(f.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    const start = page.getByRole("button", {
      name: "Start a reading timer for Offline reading book",
      exact: true,
    });
    await expect(start).toBeEnabled();
    await context.setOffline(true);
    await start.click();
    const stop = page.getByRole("button", {
      name: "Stop the reading timer for Offline reading book",
      exact: true,
    });
    await expect(stop).toContainText("0:02");
    await stop.click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await f.user.update({
      timeTracking: { provider: "none", revision: randomUUID() },
    });
    await context.setOffline(false);
    await page.reload();
    await expect(start).toBeEnabled();
    await page.goto("/me#time-tracking");
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      2,
    );
    await page.reload();
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      2,
    );
    expect((await f.user.collection("timerOperations").get()).size).toBe(0);
    expect((await f.user.collection("timeTrackingQueue").get()).size).toBe(0);
    await expect(
      page.getByRole("button", { name: "Open reading form", exact: true }),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      2,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Email address", { exact: true }).fill(f.email);
    await page.getByLabel("Password", { exact: true }).fill(f.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(start).toBeEnabled();
    await page.goto("/me#time-tracking");
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      0,
    );
  } finally {
    await f.cleanup();
  }
});
