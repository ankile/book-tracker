<script>
  import Icon from "svelte-awesome";
  import { plus, edit } from "svelte-awesome/icons";
  import { Col, Container, Progress, Row } from "sveltestrap";
  import AddReadingModal from "$lib/components/AddReadingModal.svelte";
  import UpdateCurrentModal from "$lib/components/UpdateCurrentModal.svelte";
  import NewBookModal from "$lib/components/NewBookModal.svelte";
  import ReadingSessionsModal from "$lib/components/ReadingSessionsModal.svelte";
  import { Database } from "../firebase/db";
  import { formatTime } from "../utils/format";
  import RightClickMenu from "$lib/components/RightMenu.svelte";

  let { finished, userId } = $props();

  let screenWidth = $state();

  let menuPosition = $state(null);

  let currentBook = $state(null);
  let modal = $state(null);
  const setModalBook = (book, modalType) => {
    currentBook = book;
    modal = modalType;
  };
  const closemodal = () => (currentBook = null);

  let sessionsBook = $state(null);
  const showSessions = (book) => (sessionsBook = book);
  const closeSessions = () => (sessionsBook = null);

  let books = Database.getBooks(userId, finished);

  function hasEstimate(book) {
    return book.pagesRead !== 0 && book.timeRead !== 0;
  }

  function addReading(detail) {
    Database.addReading({ userId, ...detail });
  }

  function updateCurrentPage(detail) {
    Database.addPageUpdate({ userId, ...detail });
  }

  function deleteBook(bookId) {
    let del = confirm("Are you sure you want to delete this book?");
    if (del) {
      Database.deleteBook(userId, bookId);
    }
  }

  function showMenu(event) {
    console.log(event);
    event.preventDefault();
    const { x, y } = event;

    menuPosition = { x, y };
  }
</script>

<style lang="scss">
  .book-row {
    margin: 3em;
    padding: 2em;
    text-align: start;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
  }

  .v-spacer {
    height: 10px;
  }

  .label {
    font-size: 0.9em;
    color: #666;
    text-transform: uppercase;
  }

  .author,
  .title,
  .page-number {
    font-size: 1.5em;
  }

  .author {
    color: #333;
  }

  .title {
    color: #555;
    font-style: italic;
  }

  .text-right {
    text-align: end;
  }

  .page-number {
    color: #555;
  }

  .progress-container {
    position: relative;
    width: 100%;
    min-height: 2.5em;
    margin-top: 15px;
    margin-bottom: -1em;
  }

  .progress-container :global(.progress) {
    height: 2.5em !important;
    margin: 0;
    border-radius: 0.25rem;
  }

  .progress-text-black,
  .progress-text-white {
    position: absolute;
    top: 0.45em;
    left: 0;
    width: 100%;
    text-align: center;
    font-weight: bold;
    font-size: 1em;
    pointer-events: none;
    line-height: 1;
  }

  .progress-text-black {
    color: #333;
  }

  .progress-text-white {
    color: white;
  }

  @media only screen and (max-width: 770px) {
    .author,
    .title,
    .page-number {
      font-size: 1em;
    }

    .label {
      font-size: 0.4em;
    }

    .book-row {
      margin: 2em 1em;
      padding: 1em;
    }

    .text-right {
      margin: -0.2em;
    }

    @media only screen and (max-width: 370px) {
    }
  }
</style>

<svelte:window bind:innerWidth={screenWidth} />

{#if menuPosition}
  <RightClickMenu {...menuPosition} />
{/if}

{#if currentBook && modal === 'addReading'}
  <AddReadingModal
    book={currentBook}
    onaddReading={addReading}
    oncloseModal={closemodal} />
{:else if currentBook && modal === 'updatePage'}
  <UpdateCurrentModal
    book={currentBook}
    onupdateCurrentPage={updateCurrentPage}
    oncloseModal={closemodal} />
{:else if currentBook && modal === 'editBook'}
  <NewBookModal
    open={true}
    {userId}
    book={currentBook}
    onclose={closemodal} />
{/if}

{#if sessionsBook}
  <ReadingSessionsModal
    book={sessionsBook}
    {userId}
    onclose={closeSessions} />
{/if}

<Container>
  {#each $books as book (book.id)}
    <div class="book-row" oncontextmenu={showMenu}>
      <Row>
        <Col>
          <span ondblclick={() => deleteBook(book.id)} class="label">Book Title</span>
          <span
            role="button"
            tabindex="0"
            onclick={() => setModalBook(book, 'editBook')}
            onkeypress={(e) => e.key === 'Enter' && setModalBook(book, 'editBook')}
            style="cursor: pointer; margin-left: 0.5em;">
            <Icon data={edit} scale="0.8" style="color: #666;" />
          </span>
          <br />
          <span class="author">{book.author}:</span>
          <br />
          <span class="title">{book.title}</span>
        </Col>
        <Col md="6">
          <Row>
            <Col>
              <div
                role="button"
                tabindex="0"
                class="text-right"
                style="cursor: pointer;"
                onclick={() => setModalBook(book, 'updatePage')}
                onkeypress={(e) => e.key === 'Enter' && setModalBook(book, 'updatePage')}>
                <span class="label">Page</span>
                <br />
                <span class="page-number">
                  {book.currentPage}/{book.pageCount}
                </span>
              </div>
            </Col>
            <Col>
              <div
                role="button"
                tabindex="0"
                class="text-right clickable"
                style="cursor: pointer;"
                onclick={() => showSessions(book)}
                onkeypress={(e) => e.key === 'Enter' && showSessions(book)}>
                <span class="label">Time read</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {formatTime(book.timeRead)}
                  {:else}NA{/if}
                </span>
              </div>
            </Col>

            <Col>
              <div class="text-right">
                <span class="label">Est left</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {formatTime(Math.round((book.pageCount - book.currentPage) * (book.timeRead / book.pagesRead)))}
                  {:else}NA{/if}
                </span>
              </div>
            </Col>
            <Col>
              <div class="text-right">
                <span class="label">Min/Page</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {Math.round((book.timeRead / book.pagesRead) * 100) / 100}
                  {:else}NA{/if}
                </span>
              </div>
            </Col>
          </Row>
        </Col>
        {#if !finished && screenWidth > 770}
          <Col md="1">
            <div
              role="button"
              tabindex="0"
              style="height: 100%; text-align: center;"
              onclick={() => setModalBook(book, 'addReading')}
              onkeypress={(e) => e.key === 'Enter' && setModalBook(book, 'addReading')}>
              <Icon
                data={plus}
                scale="1.7"
                style="margin: auto; top: 25%; position: relative; cursor: pointer;" />
            </div>
          </Col>
        {/if}
      </Row>
      <div class="v-spacer" />
      <Row>
        <Col>
          <div class="progress-container">
            <Progress
              color="danger"
              value={(book.currentPage / book.pageCount) * 100} />
            <div class="progress-text-black">
              {Math.round((book.currentPage / book.pageCount) * 100)}%
            </div>
            <div class="progress-text-white" style="clip-path: inset(0 {100 - (book.currentPage / book.pageCount) * 100}% 0 0);">
              {Math.round((book.currentPage / book.pageCount) * 100)}%
            </div>
          </div>
        </Col>
      </Row>
      {#if !finished && screenWidth <= 770}
        <Row>
          <Col>
            <div
              role="button"
              tabindex="0"
              style="height: 100%; text-align: center;"
              onclick={() => setModalBook(book, 'addReading')}
              onkeypress={(e) => e.key === 'Enter' && setModalBook(book, 'addReading')}>
              <Icon
                data={plus}
                scale="1.3"
                style="margin: auto; top: 25%; position: relative; cursor: pointer;" />
            </div>
          </Col>
        </Row>
      {/if}
    </div>
  {/each}
</Container>
