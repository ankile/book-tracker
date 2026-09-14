import { randomUUID } from "node:crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v1/https";
import { assertLiveAccount } from "./callerGuards";
import { consumeQuota } from "./quota";
import { threeggleRequest } from "./threeggleTransport";
import { togglFetch } from "./togglTransport";
import { decodeTogglProjects } from "./decoders";
import {
  decodeConnection,
  decodeTimerControls,
  effectiveConnection,
  sameConnection,
} from "./shared/timeTracking";
import type { Connection, Provider } from "./shared/timeTracking";
import { TIME_TRACKING_ACTIONS, wireRecord } from "./shared/time-tracking-api";

const db = getFirestore();
const secrets = getFirestore("secrets");
export function credentialRef(uid: string, revision: string) {
  return secrets.doc(`timeTrackingTokens/${uid}/revisions/${revision}`);
}
export async function timerCredential(
  uid: string,
  connection: Connection,
): Promise<string | null> {
  if (connection.provider === "none") return null;
  const doc =
    connection.revision === "legacy"
      ? await secrets.doc(`togglTokens/${uid}`).get()
      : await credentialRef(uid, connection.revision).get();
  const token: unknown = doc.get("apiToken");
  return typeof token === "string" && token.length > 0 ? token : null;
}
export async function assertConnectionIdle(
  tx: Transaction,
  uid: string,
): Promise<void> {
  const [claim, legacy, queue] = await Promise.all([
    tx.get(db.doc(`users/${uid}/timerLifecycle/current`)),
    tx.get(
      db
        .collection(`users/${uid}/togglQueue`)
        .where("status", "in", [
          "pending",
          "processing",
          "error",
          "outcome-unknown",
        ])
        .limit(1001),
    ),
    tx.get(
      db
        .collection(`users/${uid}/timeTrackingQueue`)
        .where("resolution", "==", null)
        .where("successorId", "==", null)
        .where("status", "!=", "synced")
        .limit(1),
    ),
  ]);
  if (
    (claim.exists && claim.get("state") !== "idle") ||
    legacy.size > 1000 ||
    queue.size > 1000 ||
    legacy.docs.some((d) => !d.get("legacyResolution")) ||
    queue.docs.some((d) => !d.get("resolution") && !d.get("successorId"))
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Stop your timer and resolve queued activity before changing the time tracking connection.",
    );
  }
}
export async function assertCurrentConnection(
  tx: Transaction,
  uid: string,
  expected: Connection,
): Promise<void> {
  const user = await tx.get(db.doc(`users/${uid}`));
  assertLiveAccount(user.exists, user.get("deletedAt"));
  if (!sameConnection(effectiveConnection(user.data()), expected))
    throw new HttpsError(
      "failed-precondition",
      "The time tracking connection changed. Reload before continuing.",
    );
}
export async function assertLegacyDestination(
  tx: Transaction,
  uid: string,
): Promise<void> {
  const user = await tx.get(db.doc(`users/${uid}`));
  assertLiveAccount(user.exists, user.get("deletedAt"));
  if (effectiveConnection(user.data()).provider !== "toggl")
    throw new HttpsError(
      "failed-precondition",
      "Toggl is not the selected time tracking app.",
    );
}
export async function connectionQuota(uid: string): Promise<void> {
  const user = await db.doc(`users/${uid}`).get();
  assertLiveAccount(user.exists, user.get("deletedAt"));
  const quota = await consumeQuota(
    db,
    `users/${uid}/functionQuotas/timeTrackingConnection`,
    10,
    3600000,
  );
  if (!quota.granted)
    throw new HttpsError(
      "resource-exhausted",
      "Too many connection requests. Try again later.",
    );
}
export async function inspectThreeggle(token: string) {
  const response = await threeggleRequest(token, {
    client: "book-tracker",
    action: "context",
  });
  if (!response.response.ok)
    throw new HttpsError(
      "failed-precondition",
      "Threeggle refused this timer connection.",
      { code: response.response.error.code },
    );
  const context = response.response.result;
  if (
    !("serviceId" in context) ||
    TIME_TRACKING_ACTIONS.some((a) => !context.actions.includes(a))
  )
    throw new HttpsError(
      "failed-precondition",
      "This Threeggle server does not support the required timer API.",
    );
  const projects = await threeggleRequest(token, {
    client: "book-tracker",
    action: "projects",
  });
  if (!projects.response.ok || !("projects" in projects.response.result))
    throw new HttpsError(
      "failed-precondition",
      "Threeggle projects are unavailable.",
    );
  return { context, projects: projects.response.result.projects };
}
export async function activateConnection(
  uid: string,
  input: {
    provider: Provider;
    token?: string;
    projectId?: string | number;
    expectedRevision: string;
    repair?: boolean;
    legacyInitialize?: boolean;
  },
): Promise<Connection> {
  if (
    input.provider === "none" &&
    (input.token !== undefined || input.projectId !== undefined || input.repair)
  )
    throw new HttpsError(
      "invalid-argument",
      "Local-only tracking has no credential or project.",
    );
  await connectionQuota(uid);
  const revision = input.repair ? input.expectedRevision : randomUUID();
  let next: Connection;
  let readiness = "ready";
  if (input.provider === "none") next = { provider: "none", revision };
  else {
    if (!input.token || input.token.length > 4096)
      throw new HttpsError("invalid-argument", "Enter a valid timer token.");
    if (input.provider === "threeggle") {
      const inspected = await inspectThreeggle(input.token);
      if (
        !input.repair &&
        !inspected.projects.some((p) => p.id === input.projectId)
      )
        throw new HttpsError(
          "invalid-argument",
          "Choose an active Threeggle project.",
        );
      if (typeof input.projectId !== "string")
        throw new HttpsError("invalid-argument", "Invalid Threeggle project.");
      readiness = inspected.context.readiness;
      next = {
        provider: "threeggle",
        revision,
        serviceId: inspected.context.serviceId,
        accountId: inspected.context.accountId,
        projectId: input.projectId,
      };
    } else {
      const me = await togglFetch(input.token, "GET", "/me");
      const projectReply = await togglFetch(input.token, "GET", "/me/projects");
      if (!me.ok || !projectReply.ok)
        throw new HttpsError(
          "failed-precondition",
          "Toggl refused this connection.",
        );
      const account: unknown = await me.json();
      if (
        !wireRecord(account) ||
        typeof account.id !== "number" ||
        !Number.isSafeInteger(account.id)
      )
        throw new Error("Invalid Toggl identity.");
      const projects = decodeTogglProjects(await projectReply.json());
      const project = projects.find((p) =>
        input.projectId === undefined
          ? p.name === "Reading"
          : p.id === input.projectId,
      );
      if (!project)
        throw new HttpsError(
          "failed-precondition",
          "Choose an available Toggl Reading project.",
        );
      next = {
        provider: "toggl",
        revision,
        accountId: String(account.id),
        workspaceId: project.workspaceId,
        projectId: project.id,
      };
    }
  }
  // Stage before changing the default database's authorization boundary.
  // A failed activation removes only its new revision, never the active one.
  if (input.token && !input.repair)
    await credentialRef(uid, revision).set({
      apiToken: input.token,
      updatedAt: FieldValue.serverTimestamp(),
    });
  let previous: Connection | undefined;
  try {
    await db.runTransaction(async (tx) => {
      const user = await tx.get(db.doc(`users/${uid}`));
      assertLiveAccount(user.exists, user.get("deletedAt"));
      const current = effectiveConnection(user.data());
      if (input.legacyInitialize && user.get("timeTracking") !== undefined)
        throw new HttpsError(
          "failed-precondition",
          "Use the current settings page to change this connection.",
        );
      if (current.revision !== input.expectedRevision)
        throw new HttpsError(
          "failed-precondition",
          "The connection changed. Reload settings.",
        );
      if (input.repair) {
        if (
          current.provider === "toggl" &&
          current.revision === "legacy" &&
          next.provider === "toggl" &&
          next.workspaceId === current.workspaceId &&
          next.projectId === current.projectId
        )
          next = { ...next, accountId: current.accountId };
        const comparable = { ...next, revision: current.revision };
        if (!sameConnection(current, decodeConnection(comparable)))
          throw new HttpsError(
            "failed-precondition",
            "Repair must use the same account and project.",
          );
      } else {
        const controls = decodeTimerControls(
          (await tx.get(db.doc("configuration/timeTracking"))).data(),
        );
        if (
          next.provider === "threeggle" &&
          (!controls.threeggleEnabled || controls.timerWriteVersion !== 2)
        )
          throw new HttpsError(
            "failed-precondition",
            "Threeggle integration has not been enabled yet.",
          );
        if (next.provider === "threeggle" && readiness !== "ready")
          throw new HttpsError(
            "failed-precondition",
            "Open Threeggle and let its initial setup finish before connecting.",
          );
        await assertConnectionIdle(tx, uid);
      }
      previous = current;
      tx.update(user.ref, {
        timeTracking: next,
        toggl:
          next.provider === "toggl"
            ? {
                workspaceId: next.workspaceId,
                projectId: next.projectId,
                connectedAt: FieldValue.serverTimestamp(),
              }
            : FieldValue.delete(),
      });
    });
  } catch (error) {
    if (!input.repair && input.token)
      await credentialRef(uid, revision).delete();
    throw error;
  }
  if (input.repair && input.token) {
    const repairRef =
      revision === "legacy"
        ? secrets.doc(`togglTokens/${uid}`)
        : credentialRef(uid, revision);
    await repairRef.set({
      apiToken: input.token,
      updatedAt: FieldValue.serverTimestamp(),
      ...(revision === "legacy" && next.provider === "toggl"
        ? { workspaceId: next.workspaceId, projectId: next.projectId }
        : {}),
    });
    const recheck = await db.doc(`users/${uid}`).get();
    if (
      !recheck.exists ||
      recheck.get("deletedAt") !== undefined ||
      !sameConnection(effectiveConnection(recheck.data()), next)
    ) {
      await repairRef.delete();
      assertLiveAccount(recheck.exists, recheck.get("deletedAt"));
      throw new HttpsError(
        "failed-precondition",
        "The connection changed during credential repair. Reload settings.",
      );
    }
  }
  if (previous && !input.repair) {
    if (previous.revision !== "legacy" && previous.provider !== "none")
      await credentialRef(uid, previous.revision).delete();
    await secrets.doc(`togglTokens/${uid}`).delete();
  }
  return next;
}
