<script lang="ts">
  import {
    collection,
    doc,
    getDocFromServer,
    limit,
    onSnapshot,
    query,
    where,
  } from "firebase/firestore";
  import type { UserDocument } from "../firebase/decoders.ts";
  import { db, Database } from "../firebase/db.ts";
  import { decodeBook } from "../firebase/decoders.ts";
  import type { Book } from "../interfaces/book.ts";
  import AddReadingModal from "./AddReadingModal.svelte";
  import {
    timerAcknowledge,
    timerAcknowledgeLegacy,
    timerConnect,
    timerContext,
    timerInspect,
    timerRetry,
  } from "../firebase/functions.ts";
  import {
    inspectResult,
    isTimerV2,
    pendingOperation,
    reconcileTimerOutbox,
    submitTimerOperation,
    watchTimerControls,
  } from "../firebase/timeTracking.ts";
  import {
    listOutbox,
    putOutbox,
    removeOutbox,
  } from "../firebase/timerOutbox.ts";
  import type { OutboxRecord } from "../firebase/timerOutbox.ts";
  import {
    decodeQueueV2,
    decodeTimerInterval,
    effectiveConnection,
  } from "../../../shared/timeTracking.ts";
  import type {
    Provider,
    QueueV2,
    TimerControls,
    TimerIntent,
    TimerInterval,
  } from "../../../shared/timeTracking.ts";
  import { decodeTimeTrackingResponse } from "../../../shared/time-tracking-api.ts";
  import type { TimeTrackingEntry } from "../../../shared/time-tracking-api.ts";

  let { uid, userDoc }: { uid: string; userDoc: UserDocument } = $props();
  let connection = $derived(effectiveConnection(userDoc));
  let selected = $state<Provider>("none");
  let controls = $state<TimerControls>({
    threeggleEnabled: false,
    timerWriteVersion: 1,
  });
  let token = $state("");
  let projectId = $state("");
  let projects = $state<{ id: string; name: string }[]>([]);
  let readiness = $state("");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let recoveredBook = $state<Book | null>(null);
  let recoveredMinutes = $state(1);
  let recoveredOperationId = $state<string | null>(null);
  let completed = $state<
    { id: string; title: string; interval: TimerInterval }[]
  >([]);
  let queues = $state<QueueV2[]>([]);
  let local = $state<OutboxRecord[]>([]);
  let legacy = $state<
    { id: string; title: string; status: string; eligible: boolean }[]
  >([]);
  let review = $state<QueueV2 | null>(null);
  let reviewStart = $state("");
  let reviewEnd = $state("");
  let reviewProject = $state("");
  let snapshots = $state<TimeTrackingEntry[]>([]);
  let moreSnapshots = $state(false);
  $effect(() => {
    selected = connection.provider;
    projectId = connection.provider === "threeggle" ? connection.projectId : "";
  });
  $effect(() => watchTimerControls((value) => (controls = value), showError));
  $effect(() => {
    const refresh = () => {
      void listOutbox(uid)
        .then((rows) => (local = rows))
        .catch(showError);
    };
    refresh();
    window.addEventListener("timer-outbox-change", refresh);
    return () => window.removeEventListener("timer-outbox-change", refresh);
  });
  $effect(() =>
    onSnapshot(
      query(
        collection(db, "users", uid, "timeTrackingQueue"),
        where("status", "!=", "synced"),
        where("resolution", "==", null),
        where("successorId", "==", null),
        limit(1000),
      ),
      (snap) => {
        queues = snap.docs
          .map((row) => decodeQueueV2(row.data()))
          .filter((row) => row.resolution === null && row.successorId === null);
      },
      showError,
    ),
  );
  $effect(() =>
    onSnapshot(
      query(
        collection(db, "users", uid, "timeTrackingResults"),
        where("readingPending", "==", true),
        limit(100),
      ),
      (snap) => {
        completed = snap.docs.map((row) => {
          const title: unknown = row.get("description");
          if (typeof title !== "string")
            throw new Error("Invalid completed reading title.");
          return {
            id: row.id,
            title,
            interval: decodeTimerInterval(row.get("interval")),
          };
        });
      },
      showError,
    ),
  );
  $effect(() =>
    onSnapshot(
      query(
        collection(db, "users", uid, "togglQueue"),
        where("status", "in", [
          "pending",
          "processing",
          "error",
          "outcome-unknown",
        ]),
        limit(1000),
      ),
      (snap) => {
        legacy = snap.docs
          .filter((row) => row.get("legacyResolution") === undefined)
          .map((row) => {
            const state: unknown = row.get("status"),
              title: unknown = row.get("bookTitle"),
              attempts: unknown = row.get("attempts");
            const capped = typeof attempts === "number" && attempts >= 5;
            const claimed: unknown = row.get("claimedAt");
            const stale =
              typeof claimed === "object" &&
              claimed !== null &&
              "toMillis" in claimed &&
              typeof claimed.toMillis === "function" &&
              claimed.toMillis() < Date.now() - 21600000;
            return {
              id: row.id,
              title: typeof title === "string" ? title : "Reading activity",
              status: typeof state === "string" ? state : "invalid",
              eligible:
                row.get("type") === "create" &&
                (state === "outcome-unknown" ||
                  (state === "error" && capped) ||
                  (state === "processing" && capped && stale)),
            };
          });
      },
      showError,
    ),
  );
  function failureMessage(row: QueueV2): string {
    const messages: Record<string, string> = {
      interval_overlap:
        "This time overlaps tracked activity. Review the historical snapshots and current Threeggle history before exporting again.",
      interval_too_long:
        "This interval exceeds the 31-day limit. Save the original interval, then review a correction or account for it manually.",
      overlap_check_limit:
        "Threeggle could not check this interval within its history scan limit. Review its history before choosing a new attempt, or account for the interval manually.",
      project_unavailable: row.intent.remote
        ? "The recorded entry has an unavailable project. Move it to an active project or remove its project in Threeggle, then review a new stop attempt."
        : "The selected project is archived or deleted. Review an active project for this export.",
      project_not_found:
        "The project is no longer available. Choose an active project when reviewing this export.",
      credential_missing:
        "The saved credential is missing. Repair this connection, then retry the saved request.",
      unauthorized:
        "The credential was refused. Repair this connection before retrying.",
      forbidden:
        "This token cannot control timers. Repair the connection using a timer-control token.",
      invalid_time:
        "The recorded end does not follow its start. Review the saved timestamps before exporting again.",
      end_before_start:
        "The recorded stop would precede the current remote start. Check the entry in the remote app before retrying or acknowledging it.",
      clock_ahead:
        "The server clock is ahead of Threeggle. The same saved request will retry after its wait period.",
      rate_limited:
        "The request limit was reached. Saved work will retry after the wait period.",
      row_limit:
        "The hourly activity limit was reached. Your original interval remains saved.",
      retry_limit:
        "Automatic retries have stopped. Repair the cause, then retry or acknowledge the outcome.",
      delivery_unconfirmed:
        "The remote response was lost. Threeggle requests can replay safely; check Toggl before recreating any uncertain activity.",
    };
    return row.errorCode
      ? (messages[row.errorCode] ??
          "This operation needs review. Check the remote app and the saved interval.")
      : "";
  }
  function showError(value: unknown) {
    error =
      value instanceof Error
        ? value.message
        : "Time tracking could not complete this action.";
  }
  async function run(work: () => Promise<void>) {
    busy = true;
    error = "";
    notice = "";
    try {
      await work();
    } catch (value) {
      showError(value);
    } finally {
      busy = false;
    }
  }
  async function inspect() {
    await run(async () => {
      const value = inspectResult((await timerInspect({ token })).data);
      projects = value.projects;
      readiness = value.context.readiness;
      if (!projects.some((p) => p.id === projectId))
        projectId = projects[0]?.id ?? "";
    });
  }
  async function connect(repair = false) {
    await run(async () => {
      await timerConnect({
        provider: selected,
        expectedRevision: connection.revision,
        ...(selected === "none" ? {} : { token }),
        ...(selected === "threeggle"
          ? {
              projectId:
                repair && connection.provider === "threeggle"
                  ? connection.projectId
                  : projectId,
            }
          : {}),
        repair,
      });
      token = "";
      notice = repair
        ? "Credential repaired. Saved operations can now be retried."
        : "Time tracking preference saved.";
    });
  }
  async function reviewOperation(row: QueueV2) {
    await run(async () => {
      review = row;
      reviewStart = row.intent.start;
      reviewEnd = row.intent.end ?? "";
      reviewProject =
        row.intent.connection.provider === "threeggle"
          ? row.intent.connection.projectId
          : "";
      snapshots = [];
      moreSnapshots = false;
      const result = await getDocFromServer(
        doc(db, "users", uid, "timeTrackingResults", row.intent.operationId),
      );
      if (result.get("response") !== undefined) {
        const response = decodeTimeTrackingResponse(result.get("response"));
        if (response && !response.ok && response.error.details) {
          const details = response.error.details;
          if ("entries" in details) {
            snapshots = details.entries;
            moreSnapshots = details.hasMore;
          } else if ("entry" in details && details.entry)
            snapshots = [details.entry];
          else if ("current" in details && details.current)
            snapshots = [details.current];
        }
      }
      if (row.intent.connection.provider === "threeggle")
        projects = inspectResult((await timerContext({})).data).projects;
    });
  }
  async function replace() {
    const row = review;
    if (!row) return;
    if (
      !Number.isFinite(Date.parse(reviewStart)) ||
      !Number.isFinite(Date.parse(reviewEnd)) ||
      Date.parse(reviewEnd) <= Date.parse(reviewStart)
    ) {
      error =
        "Enter valid start and end timestamps, with the end after the start.";
      return;
    }
    const intent: TimerIntent = {
      ...row.intent,
      operationId: crypto.randomUUID(),
      start: new Date(reviewStart).toISOString(),
      end: new Date(reviewEnd).toISOString(),
    };
    if (
      !confirm(
        `Export the reviewed interval ${intent.start} to ${intent.end}? This creates one new operation after the earlier request was rejected.`,
      )
    )
      return;
    await run(async () => {
      const operation = pendingOperation(uid, intent, "replace");
      operation.sourceId = row.intent.operationId;
      if (
        row.intent.remote === null &&
        row.intent.connection.provider === "threeggle" &&
        reviewProject !== row.intent.connection.projectId
      )
        operation.correctedProjectId = reviewProject;
      await submitTimerOperation(operation);
      review = null;
    });
  }
  async function acknowledge(row: QueueV2) {
    if (
      !confirm(
        "Check the remote app first. Confirm that this activity has been accounted for and any remote timer has been stopped or deleted. The saved failure will be retained, and this action will not resend it.",
      )
    )
      return;
    await run(async () => {
      const book = await getDocFromServer(
        doc(db, "users", uid, "books", row.intent.bookId),
      );
      const timer: unknown = book.get("activeTimer");
      if (isTimerV2(timer) && timer.queueId === row.intent.operationId) {
        const intent: TimerIntent = {
          ...row.intent,
          action: "clear",
          operationId: crypto.randomUUID(),
          start: timer.start,
          end: null,
          remote: timer.remote,
        };
        await submitTimerOperation(
          pendingOperation(uid, intent, "clear", timer),
        );
      } else
        await timerAcknowledge({
          operationId: row.intent.operationId,
          remoteChecked: true,
        });
    });
  }
  async function acknowledgeLegacy(id: string) {
    if (
      !confirm(
        "Have you checked Toggl and accounted for this activity? Acknowledging preserves the failed operation and will not resend it.",
      )
    )
      return;
    await run(async () => {
      await timerAcknowledgeLegacy({ queueId: id, remoteChecked: true });
    });
  }
  async function recoverReading(
    row: Pick<OutboxRecord, "intent">,
    operationId: string | null = null,
  ) {
    if (!row.intent.end) return;
    if (
      !confirm(
        "Check that you have not already added this reading session. Open the reading form with the saved duration? This does not export time to another app.",
      )
    )
      return;
    await run(async () => {
      const snap = await getDocFromServer(
        doc(db, "users", uid, "books", row.intent.bookId),
      );
      if (!snap.exists())
        throw new Error(
          "This book was removed. Save the interval file to keep its time.",
        );
      recoveredBook = decodeBook(snap.id, snap.data(), snap.ref.path);
      recoveredOperationId = operationId;
      recoveredMinutes = Math.max(
        1,
        Math.round(
          (Date.parse(row.intent.end ?? row.intent.start) -
            Date.parse(row.intent.start)) /
            60000,
        ),
      );
    });
  }
  async function recoverCompleted(row: {
    id: string;
    interval: TimerInterval;
  }) {
    await run(async () => {
      const snap = await getDocFromServer(
        doc(db, "users", uid, "timeTrackingQueue", row.id),
      );
      const queued = decodeQueueV2(snap.data());
      await recoverReading(
        { intent: { ...queued.intent, ...row.interval } },
        row.id,
      );
    });
  }
  async function acknowledgeReading(id: string) {
    if (
      !confirm("Have you already recorded or accounted for this reading time?")
    )
      return;
    await run(async () => {
      await timerAcknowledge({ operationId: id, readingChecked: true });
    });
  }
  function recordRecoveredReading(data: {
    id: string;
    timeRead: number;
    currentPage: number;
    previousPage: number;
  }) {
    const book = recoveredBook;
    const operationId = recoveredOperationId;
    if (!book) throw new Error("No recovery book selected.");
    void run(async () => {
      await Database.addReading({
        userId: uid,
        title: book.title,
        pageCount: book.pageCount,
        ...data,
      });
      if (operationId)
        await timerAcknowledge({ operationId, readingChecked: true });
      notice = operationId
        ? "Reading session saved."
        : "Reading session saved. The original device operation remains available for review.";
    });
  }
  function download(row: OutboxRecord) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(row.intent, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `reading-interval-${row.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function discard(row: OutboxRecord) {
    if (
      !confirm(
        "Remove this saved device operation? Save its interval first. This will not stop a timer or remove activity in the remote app.",
      )
    )
      return;
    await run(async () => {
      await removeOutbox(uid, row.id);
    });
  }
</script>

{#if recoveredBook}<AddReadingModal
    book={recoveredBook}
    initialTime={recoveredMinutes}
    onaddReading={recordRecoveredReading}
    oncloseModal={() => (recoveredBook = null)}
  />{/if}
<section
  id="time-tracking"
  class="tracking-card"
  aria-labelledby="tracking-title"
>
  <h2 id="tracking-title">Time tracking</h2>
  <p class="description">
    Choose one app for all reading timers. Your choice stays in effect until you
    change it.
  </p>
  <p class="status">
    Current choice: <strong
      >{connection.provider === "none"
        ? "Neither"
        : connection.provider === "toggl"
          ? "Toggl Track"
          : "Threeggle"}</strong
    >
  </p>
  <label for="tracking-provider">Send reading time to</label>
  <select id="tracking-provider" class="form-control" bind:value={selected} disabled={busy}>
    <option value="none">Neither — keep time in Book Tracker</option>
    <option value="toggl">Toggl Track</option>
    <option
      value="threeggle"
      disabled={!controls.threeggleEnabled &&
        connection.provider !== "threeggle"}>Threeggle</option
    >
  </select>
  {#if selected !== "none"}
    <p>
      {selected === "threeggle"
        ? "Create a timer connection in Threeggle, then paste its token here."
        : "Paste your Toggl API token. Your Toggl account needs an active project named Reading."}
      The token is stored on the server.
    </p>
    <label for="tracking-token"
      >{selected === "threeggle"
        ? "Threeggle timer token"
        : "Toggl API token"}</label
    >
    <input
      id="tracking-token"
      class="form-control"
      type="password"
      autocomplete="off"
      bind:value={token}
    />
    {#if selected === "threeggle"}
      <button type="button" class="secondary-button" disabled={busy || !token} onclick={inspect}
        >Load Threeggle projects</button
      >
      <label for="tracking-project">Reading project</label>
      <select
        id="tracking-project"
        class="form-control"
        bind:value={projectId}
        disabled={busy || projects.length === 0}
      >
        {#each projects as project}<option value={project.id}
            >{project.name}</option
          >{/each}
      </select>
      {#if readiness && readiness !== "ready"}<p>
          Open Threeggle and let its initial setup finish before connecting. You
          can still repair an existing credential.
        </p>{/if}
    {/if}
  {/if}
  {#if controls.timerWriteVersion !== 2}<p>
      Connection changes will be available after the timer update is enabled.
      Existing timers and recovery remain available.
    </p>{/if}
  <div class="actions">
    <button
      type="button"
      class="primary-button"
      disabled={busy ||
        controls.timerWriteVersion !== 2 ||
        (selected !== "none" && !token) ||
        (selected === "threeggle" && !projectId)}
      onclick={() => connect()}>Save choice</button
    >
    {#if selected === connection.provider && selected !== "none"}
      <button
        type="button"
        class="secondary-button"
        disabled={busy || !token}
        onclick={() => connect(true)}>Repair credential</button
      >
    {/if}
  </div>
  <p class="hint">
    Stop timers and resolve queued activity before changing apps or projects.
    Disconnecting removes the saved token; you can also revoke it in the remote
    app.
  </p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}

  {#if completed.length}
    <h3>Completed remotely</h3>
    <p>
      These recovered timers have finished in Threeggle. Review their confirmed
      time before adding a reading session.
    </p>
    {#each completed as row (row.id)}
      <article aria-label={`Completed reading: ${row.title}`}>
        <strong>{row.title}</strong>
        <p>
          {new Date(row.interval.start).toLocaleString()} to {new Date(
            row.interval.end,
          ).toLocaleString()}
        </p>
        <button
          type="button"
          class="secondary-button"
          disabled={busy}
          onclick={() => recoverCompleted(row)}>Open reading form</button
        >
        <button
          type="button"
          class="secondary-button"
          disabled={busy}
          onclick={() => acknowledgeReading(row.id)}
          >Already accounted for</button
        >
      </article>
    {/each}
  {/if}

  {#if queues.length || legacy.length || local.length}
    <h3>Saved activity and recovery</h3>
    {#each queues as row (row.intent.operationId)}
      <article>
        <strong>{row.intent.description}</strong>
        <p>{row.intent.start}{row.intent.end ? ` to ${row.intent.end}` : ""}</p>
        <p>
          {row.intent.connection.provider} · {row.status}{row.errorCode
            ? ` · ${failureMessage(row)}`
            : ""}
        </p>
        <div class="actions">
          {#if ["pending", "paused", "processing"].includes(row.status)}<button
              type="button"
              class="secondary-button"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await timerRetry({ operationId: row.intent.operationId });
                })}>Retry saved request</button
            >{/if}
          <button
            type="button"
            class="secondary-button"
            disabled={busy}
            onclick={() => reviewOperation(row)}>Review</button
          >
          {#if row.status === "terminal" || row.status === "outcome-unknown" || row.status === "paused"}<button
              type="button"
              class="secondary-button"
              disabled={busy}
              onclick={() => acknowledge(row)}
              >I checked the remote outcome</button
            >{/if}
        </div>
      </article>
    {/each}
    {#each legacy as row (row.id)}
      <article>
        <strong>{row.title}</strong>
        <p>Toggl · {row.status}</p>
        {#if row.eligible}<button
            type="button"
            class="secondary-button"
            disabled={busy}
            onclick={() => acknowledgeLegacy(row.id)}
            >I checked the remote outcome</button
          >{:else}<p>
            Let this operation finish. A failed remote stop is resolved from its
            book timer.
          </p>{/if}
      </article>
    {/each}
    {#each local as row (row.id)}
      <article>
        <strong>{row.intent.description}</strong>
        <p>Saved on this device · {row.state}</p>
        <p>{row.intent.start}{row.intent.end ? ` to ${row.intent.end}` : ""}</p>
        {#if row.state === "recovery"}<p>
            The original connection or timer changed. This interval will not be
            sent to your current connection automatically.
          </p>{/if}
        <div class="actions">
          <button
            type="button"
            class="secondary-button"
            disabled={busy}
            onclick={() =>
              run(async () => {
                await reconcileTimerOutbox(uid);
              })}>Check saved operation</button
          ><button type="button" class="secondary-button" onclick={() => download(row)}
            >Save interval file</button
          >{#if row.state === "recovery"}{#if row.intent.end}<button
                type="button"
                class="secondary-button"
                disabled={busy}
                onclick={() => recoverReading(row)}>Open reading form</button
              >{/if}<button
              type="button"
              class="secondary-button"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await putOutbox({
                    ...row,
                    state: "pending",
                    errorCode: null,
                  });
                  await reconcileTimerOutbox(uid);
                })}>Retry original operation</button
            ><button type="button" class="secondary-button" disabled={busy} onclick={() => discard(row)}
              >Discard device copy</button
            >{/if}
        </div>
      </article>
    {/each}
  {/if}
  {#if review}
    <section class="review" aria-label="Review saved time tracking operation">
      <h3>Review saved operation</h3>
      <p>{review.intent.description}</p>
      {#if snapshots.length}
        <p>
          Historical snapshots returned when this request was checked. Open
          Threeggle to see current entry details.
        </p>
        {#each snapshots as entry}<p>
            {entry.description} · {new Date(entry.startTime).toLocaleString()} to
            {entry.endTime === null
              ? "running"
              : new Date(entry.endTime).toLocaleString()}
          </p>{/each}
        {#if moreSnapshots}<p>More entries overlapped this interval.</p>{/if}
      {/if}
      {#if review.status === "terminal" && review.intent.action === "stop"}
        <label for="review-start">Start (ISO timestamp)</label><input
          id="review-start"
          class="form-control"
          bind:value={reviewStart}
          readonly={review.intent.remote !== null}
        />
        <label for="review-end">End (ISO timestamp)</label><input
          id="review-end"
          class="form-control"
          bind:value={reviewEnd}
        />
        {#if review.intent.connection.provider === "threeggle" && review.intent.remote === null && ["project_unavailable", "project_not_found"].includes(review.errorCode ?? "")}<label
            for="review-project">Project for this export</label
          ><select id="review-project" class="form-control" bind:value={reviewProject}
            >{#each projects as project}<option value={project.id}
                >{project.name}</option
              >{/each}</select
          >{/if}
        <button type="button" class="secondary-button" disabled={busy || !reviewEnd} onclick={replace}
          >Export reviewed interval</button
        >
      {:else if review.status === "outcome-unknown"}<p>
          The remote outcome is unknown. Check the remote app before recording
          this activity again.
        </p>
      {:else if review.intent.action === "start"}<p>
          If the start was rejected, begin a fresh timer from your book after
          resolving the failure.
        </p>{/if}
      <button type="button" class="secondary-button" onclick={() => (review = null)}>Close review</button
      >
    </section>
  {/if}
</section>

<style>
  /* A flat section of the Settings card, matching the Profile and Sharing
     sections above it: hairline on top, no box of its own. */
  .tracking-card {
    border-top: 1px solid #e0e0e0;
    padding: 1.5rem 0 0;
    scroll-margin-top: 5rem;
  }
  h2 {
    font-size: 1.5rem;
    color: #333;
    margin: 0 0 1rem;
  }
  h3 {
    font-size: 1.1rem;
    color: #333;
    margin: 1.5rem 0 0.5rem;
  }
  p {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .description {
    max-width: 720px;
    margin: 0 0 1.35rem;
    color: #666;
    font-size: 0.92rem;
  }
  .status {
    color: #555;
  }
  label {
    display: block;
    color: #555;
    font-size: 0.78rem;
    font-weight: 650;
    margin-top: 0.8rem;
  }
  .form-control {
    margin: 0.3rem 0 0.7rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  article .actions {
    margin-top: 0.75rem;
  }
  .primary-button,
  .secondary-button {
    min-height: 40px;
    padding: 0.55rem 0.9rem;
    font-size: 0.88rem;
    font-weight: 650;
    line-height: 1.1;
    border-radius: 8px;
    box-shadow: none;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .primary-button:disabled,
  .secondary-button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .primary-button {
    color: #fff;
    background: #2f666b;
    border: 1px solid #2f666b;
  }
  .primary-button:hover:not(:disabled) {
    background: #27575c;
    border-color: #27575c;
  }
  .secondary-button {
    color: #333;
    background: #fff;
    border: 1px solid #d8d8d8;
  }
  .secondary-button:hover:not(:disabled) {
    background: #f7f7f7;
    border-color: #bdbdbd;
  }
  .hint {
    margin-top: 1rem;
    font-size: 0.9rem;
    color: #626262;
  }
  .error {
    color: #b42318;
  }
  article {
    border-top: 1px solid #ededed;
    padding: 1rem 0;
  }
  .review {
    border: 1px solid #d8d8d8;
    border-radius: 8px;
    padding: 1rem;
    margin-top: 1rem;
  }
  @media (max-width: 768px) {
    .actions .primary-button,
    .actions .secondary-button {
      flex: 1 1 auto;
    }
  }
</style>
