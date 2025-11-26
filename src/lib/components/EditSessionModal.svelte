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
  let inputFromPage = $state(session?.fromPage || 0);
  let inputToPage = $state(session?.toPage || 0);

  $effect(() => {
    if (session) {
      inputTime = session.timeRead;
      inputFromPage = session.fromPage;
      inputToPage = session.toPage;
    }
  });

  function updateSession() {
    if (inputTime <= 0) {
      alert("Time read must be greater than 0");
      return;
    }

    if (inputFromPage < 0 || inputToPage < 0) {
      alert("Page numbers must be positive");
      return;
    }

    if (inputToPage <= inputFromPage) {
      alert("End page must be greater than start page");
      return;
    }

    if (book && (inputFromPage > book.pageCount || inputToPage > book.pageCount)) {
      alert(`Page numbers cannot exceed book's total pages (${book.pageCount})`);
      return;
    }

    // Verify this is the most recent session by checking if its toPage matches the book's currentPage
    if (book && session.toPage !== book.currentPage) {
      alert("Only the most recent reading session can be edited");
      return;
    }

    onupdateSession({
      sessionId: session.id,
      timeRead: inputTime,
      fromPage: inputFromPage,
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
  <Input label="From page" inputId="inputFromPage">
    <input
      id="inputFromPage"
      class="form-control"
      type="number"
      placeholder="Starting page"
      bind:value={inputFromPage} />
  </Input>
  <div style="height: 8px;" />
  <Input label="To page" inputId="inputToPage">
    <input
      id="inputToPage"
      class="form-control"
      type="number"
      placeholder="Ending page"
      bind:value={inputToPage} />
  </Input>
</ModalCard>
