<script lang="ts">
  import Input from "$lib/components/Input.svelte";
  import ModalCard from "$lib/components/ModalCard.svelte";
  import { validateReading } from "$lib/utils/validation.ts";
  import type { Book } from "$lib/interfaces/book.ts";
  import type { ReadingSession } from "$lib/interfaces/reading.ts";

  let {
    session,
    book,
    onupdateSession,
    oncloseModal
  }: {
    session: ReadingSession;
    book: Book;
    onupdateSession: (data: { sessionId: string; timeRead: number; fromPage: number; toPage: number }) => void;
    oncloseModal: () => void;
  } = $props();

  // The modal is created fresh each time it opens, so capturing the
  // initial values here is intentional; syncing via $effect instead would
  // clobber in-progress input whenever a Firestore snapshot re-emits.
  // svelte-ignore state_referenced_locally
  let inputTime = $state<number | null>(session.timeRead);
  // svelte-ignore state_referenced_locally
  let inputToPage = $state<number | null>(session.toPage);

  function updateSession() {
    const result = validateReading({
      inputTime,
      inputPages: inputToPage,
      previousPage: session.fromPage,
      pageCount: book.pageCount,
    });
    if (!result.valid) {
      alert(result.message);
      return;
    }
    if (result.pages === session.fromPage) {
      alert(`End page must be greater than start page (${session.fromPage})`);
      return;
    }

    onupdateSession({
      sessionId: session.id,
      timeRead: result.time,
      fromPage: session.fromPage, // Keep the original fromPage
      toPage: result.pages,
    });
    oncloseModal();
  }

  function closeModal() {
    oncloseModal();
  }
</script>

<ModalCard
  open={!!session}
  onclose={closeModal}
  primaryText="Update"
  primaryAction={updateSession}
  header="Edit Reading Session">
  <Input label="Minutes read" inputId="inputTime">
    <input
      id="inputTime"
      class="form-control"
      placeholder="Minutes of reading"
      bind:value={inputTime}
      type="number" />
  </Input>
  <div style="height: 8px;"></div>
  <div style="margin-bottom: 1rem;">
    <p style="font-size: 0.9rem; color: #666; margin-bottom: 0.25rem;">From page (cannot be changed)</p>
    <div style="padding: 0.5rem; background-color: #f5f5f5; border-radius: 4px; color: #666;">
      {session?.fromPage || 0}
    </div>
  </div>
  <Input label="To page" inputId="inputToPage">
    <input
      id="inputToPage"
      class="form-control"
      type="number"
      placeholder="Ending page"
      bind:value={inputToPage} />
  </Input>
</ModalCard>
