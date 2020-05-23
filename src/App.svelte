<script>
  import {
    Button,
    Navbar,
    NavbarBrand,
    Row,
    Col,
    Container,
    Progress,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Label,
    Input
  } from "sveltestrap";

  import Icon from "svelte-awesome";
  import { plus } from "svelte-awesome/icons";

  import { formatTime } from "./utils/format";

  import { Database } from "./firebase/db";

  import AddReadingModal from "./AddReadingModal.svelte";

  let currentBook = null;
  const setModalBook = book => {
    currentBook = book;
  };
  const closemodal = () => (currentBook = null);

  let books = Database.getBooks();

  function hasEstimate(book) {
    return book.pagesRead !== 0 && book.timeRead !== 0;
  }
</script>

<style>
  main {
    text-align: center;
    padding: 0;
    max-width: 240px;
    margin: 0 auto;
  }

  h1 {
    color: #555;
    text-transform: uppercase;
    font-size: 2.5em;
    font-weight: 100;
    margin: 1em 0;
  }

  .book-row {
    margin: 2em;
    padding: 1em;
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

  .author {
    font-size: 1.5em;
    color: #333;
  }

  .title {
    font-size: 1.5em;
    color: #555;
    font-style: italic;
  }

  .text-right {
    text-align: end;
  }

  .page-number {
    font-size: 1.5em;
    color: #555;
  }

  @media (min-width: 640px) {
    main {
      max-width: none;
    }
  }
</style>

<main>
  {#if currentBook}
    <AddReadingModal
      book={currentBook}
      on:addReading={Database.addReading}
      on:closeModal={closemodal} />
  {/if}

  <Navbar color="dark" dark class="mb-2">
    <NavbarBrand>Previous</NavbarBrand>
    <NavbarBrand>Right Now</NavbarBrand>
    <NavbarBrand>Statistics</NavbarBrand>
  </Navbar>

  <h1>Reading Right Now</h1>

  <Container>
    {#each $books as book}
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
                <div class="text-right">
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
          <Col md="1">
            <div
              style="height: 100%; text-align: center;"
              on:click={() => setModalBook(book)}>
              <Icon
                data={plus}
                scale="1.7"
                style="margin: auto; top: 25%; position: relative;" />
            </div>
          </Col>
        </Row>
        <div class="v-spacer" />
        <Row>
          <Col>
            <Progress
              color="danger"
              value={(book.currentPage / book.pageCount) * 100} />
          </Col>
          <Col md="1">
            {Math.round((book.currentPage / book.pageCount) * 100)}%
          </Col>
        </Row>
      </div>
    {/each}
  </Container>
</main>
