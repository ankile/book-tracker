import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { test, expect, type Page } from "@playwright/test";
import {
  decodeTimerIntent,
  initialQueue,
  operationAck,
} from "../../shared/timeTracking.ts";

async function deviceRows(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("book-tracker-timer-outbox", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const read = database
            .transaction("operations")
            .objectStore("operations")
            .getAll();
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            const rows: unknown = read.result;
            database.close();
            if (!Array.isArray(rows)) reject(new Error("Invalid outbox"));
            else resolve(rows);
          };
        };
      }),
  );
}
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
    await expect.poll(() => deviceRows(page)).toHaveLength(2);
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
    const cancelSignOut = page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await cancelSignOut;
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      2,
    );
    const confirmSignOut = page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      await dialog.accept();
    });
    // Sign-out clears Firestore persistence and reloads. The transient
    // signed-out render before that reload is not ready for a new login.
    const signedOutReload = page.waitForEvent("load");
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await confirmSignOut;
    await signedOutReload;
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Email address", { exact: true }).fill(f.email);
    await page.getByLabel("Password", { exact: true }).fill(f.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    // Cache cleanup returns to Reading; Sign Out belongs to Settings only.
    await expect(start).toBeEnabled();
    await page.goto("/me#time-tracking");
    await expect(page.getByText("Saved on this device · recovery")).toHaveCount(
      0,
    );
  } finally {
    await f.cleanup();
  }
});

for (const scenario of ["external switch", "edited remote start"] as const)
  test(`online Threeggle reading form waits for the confirmed interval after ${scenario}`, async ({
    page,
  }) => {
    const f = await fixture("none");
    const connection = {
      provider: "threeggle" as const,
      revision: randomUUID(),
      serviceId: "browser-test",
      accountId: "browser-account",
      projectId: "reading",
    };
    const start = new Date(Date.now() - 3600000).toISOString();
    const timer = {
      version: 2 as const,
      timerId: randomUUID(),
      operationId: randomUUID(),
      connection,
      state: "remote" as const,
      start,
      claimedAt: Date.now() - 3600000,
      remote: { provider: "threeggle" as const, entryKey: "external-entry" },
      queueId: null,
      errorCode: null,
    };
    const finalStart =
      scenario === "external switch"
        ? start
        : new Date(Date.parse(start) + 1800000).toISOString();
    const finalEnd = new Date(
      Date.parse(finalStart) +
        (scenario === "external switch" ? 600000 : 300000),
    ).toISOString();
    await f.user.update({ timeTracking: connection });
    await f.book.update({ activeTimer: timer });
    await f.user
      .collection("timerLifecycle")
      .doc("current")
      .set({ version: 2, state: "active", bookId: f.book.id, timer });
    let operationId: string | null = null;
    await page.route("**/timetracking-accept", async (route) => {
      const payload: unknown = route.request().postDataJSON();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("data" in payload) ||
        typeof payload.data !== "object" ||
        payload.data === null ||
        !("intent" in payload.data)
      )
        throw new Error("Missing stop intent");
      const intent = decodeTimerIntent(payload.data.intent);
      expect(intent.action).toBe("stop");
      expect(intent.remote).toEqual(timer.remote);
      const batch = f.db.batch();
      batch.set(f.user.collection("timerOperations").doc(intent.operationId), {
        ...operationAck(intent, Date.now()),
        intent,
      });
      batch.set(
        f.user.collection("timeTrackingQueue").doc(intent.operationId),
          { ...initialQueue(intent, Date.now()), status: "processing", attempts: 1, claimedAt: Date.now() },
      );
      await batch.commit();
      operationId = intent.operationId;
      await route.fulfill({
        json: { result: { accepted: true, operationId: intent.operationId } },
      });
    });
    try {
      await page.goto("/");
      await page.getByLabel("Email address", { exact: true }).fill(f.email);
      await page.getByLabel("Password", { exact: true }).fill(f.password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Stop the reading timer for Offline reading book",
          exact: true,
        })
        .click();
      await expect.poll(() => operationId).not.toBeNull();
      await expect(
        page.getByRole("dialog", { name: "Offline reading book", exact: true }),
      ).not.toBeVisible();
      if (operationId === null) throw new Error("Stop not submitted");
      const batch = f.db.batch();
      batch.set(f.user.collection("timeTrackingResults").doc(operationId), {
        interval: { start: finalStart, end: finalEnd },
        recordedAt: Date.now(),
      });
      batch.update(f.user.collection("timeTrackingQueue").doc(operationId), {
        status: "synced",
      });
      batch.update(f.book, { activeTimer: null });
      batch.set(f.user.collection("timerLifecycle").doc("current"), {
        version: 2,
        state: "idle",
        cleared: { bookId: f.book.id, timerId: timer.timerId, operationId },
      });
      await batch.commit();
      await expect(
        page.getByRole("spinbutton", { name: "Minutes read", exact: true }),
      ).toHaveValue(scenario === "external switch" ? "10" : "5");
      await expect(
        page.getByText("Estimated from this device.", { exact: false }),
      ).not.toBeVisible();
    } finally {
      await f.cleanup();
    }
  });

test("online Toggl reading uses the targeted stop's confirmed duration", async ({
  page,
}) => {
  const f = await fixture("toggl");
  const timer = {
    version: 2,
    timerId: randomUUID(),
    operationId: randomUUID(),
    connection: (await f.user.get()).get("timeTracking"),
    state: "remote",
    start: new Date(Date.now() - 3600000).toISOString(),
    claimedAt: Date.now() - 3600000,
    remote: { provider: "toggl", entryId: 900003 },
    queueId: null,
    errorCode: null,
  };
  await f.book.update({ activeTimer: timer });
  await f.user
    .collection("timerLifecycle")
    .doc("current")
    .set({ version: 2, state: "active", bookId: f.book.id, timer });
  try {
    await page.goto("/");
    await page.getByLabel("Email address", { exact: true }).fill(f.email);
    await page.getByLabel("Password", { exact: true }).fill(f.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Stop the reading timer for Offline reading book",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Minutes read", exact: true }),
    ).toHaveValue("1");
    const rows = await f.user.collection("timeTrackingQueue").get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].get("prepared.action")).toBe("stop_now");
    expect(rows.docs[0].get("status")).toBe("synced");
  } finally {
    await f.cleanup();
  }
});
