<script>
  import Input from "$lib/components/Input.svelte";
  import ModalCard from "$lib/components/ModalCard.svelte";

  let {
    session,
    book,
    onupdateSession,
    oncloseModal
  } = $props();

  let inputTime = $state(session?.timeRead || 0);
  let inputToPage = $state(session?.toPage || 0);

  $effect(() => {
    if (session) {
      inputTime = session.timeRead;
      inputToPage = session.toPage;
    }
  });

  function updateSession() {
    if (inputTime <= 0) {
      alert("Time read must be greater than 0");
      return;
    }

    if (inputToPage < 0) {
      alert("Page numbers must be positive");
      return;
    }

    if (inputToPage <= session.fromPage) {
      alert(`End page must be greater than start page (${session.fromPage})`);
      return;
    }

    if (book && inputToPage > book.pageCount) {
      alert(`Page number cannot exceed book's total pages (${book.pageCount})`);
      return;
    }

    onupdateSession({
      sessionId: session.id,
      timeRead: inputTime,
      fromPage: session.fromPage, // Keep the original fromPage
      toPage: inputToPage,
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
  <div style="height: 8px;" />
  <div style="margin-bottom: 1rem;">
    <label style="font-size: 0.9rem; color: #666; display: block; margin-bottom: 0.25rem;">From page (cannot be changed)</label>
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
