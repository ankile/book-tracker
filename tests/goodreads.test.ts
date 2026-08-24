import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGoodreadsHtml, deriveFictionFromGenres, extractGenres, goodreadsIsbnUrl,
} from "../src/lib/utils/goodreads.ts";

const page = (jsonLd: unknown, genres: string[] = ["Fiction", "Classics"]): string => `
  <html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>
  <body>${genres.map((g) => `{"name":"${g}","webUrl":"https://www.goodreads.com/genres/${g.toLowerCase()}"}`).join("")}</body></html>`;

const bookLd = {
  "@type": "Book",
  name: "Sult",
  image: "https://m.media-amazon.com/images/S/x/13603048.jpg",
  numberOfPages: 208,
  isbn: "9788205394810",
  author: [{ "@type": "Person", name: "Knut Hamsun" }],
};

test("the robots-allowed isbn route is used, not /search", () => {
  assert.equal(goodreadsIsbnUrl("9788205394810"), "https://www.goodreads.com/book/isbn/9788205394810");
});

test("a book page parses into the metadata shape", () => {
  const parsed = parseGoodreadsHtml(page(bookLd));
  assert.ok(parsed);
  assert.equal(parsed.title, "Sult");
  assert.deepEqual(parsed.authorNames, ["Knut Hamsun"]);
  assert.equal(parsed.pageCount, 208);
  assert.equal(parsed.coverUrl, "https://m.media-amazon.com/images/S/x/13603048.jpg");
  assert.deepEqual(parsed.subjects, ["Fiction", "Classics"]);
  assert.equal(parsed.fiction, true);
});

test("a page without book JSON-LD yields nothing rather than a guess", () => {
  assert.equal(parseGoodreadsHtml("<html><body>404</body></html>"), null);
  assert.equal(parseGoodreadsHtml(page({ "@type": "WebPage", name: "Search" })), null);
});

test("malformed optional Goodreads fields degrade independently", () => {
  const parsed = parseGoodreadsHtml(page({
    "@type": "Book",
    name: 42,
    author: [null, { name: "Valid Author" }, { name: 7 }],
    numberOfPages: "208",
    image: { url: "https://example.com/cover.jpg" },
  }, []));
  assert.ok(parsed);
  assert.equal(parsed.title, "");
  assert.deepEqual(parsed.authorNames, ["Valid Author"]);
  assert.equal(parsed.pageCount, undefined);
  assert.equal(parsed.coverUrl, "");
  assert.deepEqual(parsed.subjects, []);
  assert.equal(parsed.fiction, null);
});

test("Goodreads accepts one author object and ignores wrong containers", () => {
  const oneAuthor = parseGoodreadsHtml(page({
    "@type": "Book",
    author: { name: "Solo Author" },
  }));
  assert.ok(oneAuthor);
  assert.deepEqual(oneAuthor.authorNames, ["Solo Author"]);

  const wrongContainer = parseGoodreadsHtml(page({ "@type": "Book", author: "Nobody" }));
  assert.ok(wrongContainer);
  assert.deepEqual(wrongContainer.authorNames, []);
});

test("invalid Goodreads JSON-LD still fails loudly", () => {
  assert.throws(
    () => parseGoodreadsHtml('<script type="application/ld+json">{broken}</script>'),
    SyntaxError,
  );
});

test("genres are de-duplicated in page order", () => {
  assert.deepEqual(extractGenres(page(bookLd, ["Fiction", "Novels", "Fiction"])), ["Fiction", "Novels"]);
});

test("an explicit Nonfiction tag classifies as non-fiction", () => {
  assert.equal(deriveFictionFromGenres(["Nonfiction", "Memoir", "History"]), false);
  assert.equal(deriveFictionFromGenres(["Non-Fiction"]), false);
});

test("a Fiction tag outranks topic tags that merely look factual", () => {
  assert.equal(deriveFictionFromGenres(["History", "Historical Fiction"]), true);
});

test("known non-fiction genres classify without an explicit tag", () => {
  assert.equal(deriveFictionFromGenres(["Memoir"]), false);
  assert.equal(deriveFictionFromGenres(["Philosophy", "Essays"]), false);
});

test("unrecognized genres stay unknown", () => {
  assert.equal(deriveFictionFromGenres(["Audiobook", "Family"]), null);
  assert.equal(deriveFictionFromGenres([]), null);
});
