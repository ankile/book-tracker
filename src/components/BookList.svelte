<script>
  import Icon from "svelte-awesome";
  import { plus } from "svelte-awesome/icons";
  import { Col, Container, Progress, Row } from "sveltestrap";
  import AddReadingModal from "./AddReadingModal.svelte";
  import UpdateCurrentModal from "./UpdateCurrentModal.svelte";
  import { Database } from "../firebase/db";
  import { formatTime } from "../utils/format";

  export let finished;
  export let userId;

  let screenWidth;

  let currentBook = null;
  let modal = null;
  const setModalBook = (book, modalType) => {
    currentBook = book;
    modal = modalType;
  };
  const closemodal = () => (currentBook = null);

  let books = Database.getBooks(userId, finished);

  function hasEstimate(book) {
    return book.pagesRead !== 0 && book.timeRead !== 0;
  }

  function addReading({ detail }) {
    Database.addReading({ userId, ...detail });
  }

  function updateCurrentPage({ detail }) {
    Database.addPageUpdate({ userId, ...detail });
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

{#if currentBook && modal === 'addReading'}
  <AddReadingModal
    book={currentBook}
    on:addReading={addReading}
    on:closeModal={closemodal} />
{:else if currentBook && modal === 'updatePage'}
  <UpdateCurrentModal
    book={currentBook}
    on:updateCurrentPage={updateCurrentPage}
    on:closeModal={closemodal} />
{/if}

<Container>
  {#each $books as book (book.id)}
    <div class="book-row">
      <Row>
        <Col>
          <span class="label">Book Title</span>
          <br />
          <span class="author">{book.author}:</span>
          <span class="title">{book.title}</span>
        </Col>
        <Col md="6">
          <Row>
            <Col>
              <div
                class="text-right"
                style="cursor: pointer;"
                on:click={() => setModalBook(book, 'updatePage')}>
                <span class="label">Page</span>
                <br />
                <span class="page-number">
                  {book.currentPage}/{book.pageCount}
                </span>
              </div>
            </Col>
            <Col>
              <div class="text-right">
                <span class="label">Time read</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {formatTime(Math.round(book.currentPage * (book.timeRead / book.pagesRead)))}
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
              style="height: 100%; text-align: center;"
              on:click={() => setModalBook(book, 'addReading')}>
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
          <div
            style="display: flex; flex-direction: column; justify-content: center; height: 100%;">
            <Progress
              color="danger"
              value={(book.currentPage / book.pageCount) * 100} />
          </div>
        </Col>
        <Col xs="3">
          <div
            style="display: flex; flex-direction: column; justify-content: center; height: 100%;">
            {Math.round((book.currentPage / book.pageCount) * 100)}%
          </div>
        </Col>
      </Row>
      {#if !finished && screenWidth <= 770}
        <Row>
          <Col>
            <div
              style="height: 100%; text-align: center;"
              on:click={() => setModalBook(book, 'addReading')}>
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
