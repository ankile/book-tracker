import assert from "node:assert/strict";
import test from "node:test";

import {
  parseNbItem, deriveFictionFromNbGenres, extractModsCoverUrl, extractModsGenres, extractModsLanguage,
  flipCatalogueName, nbCoverCandidate,
} from "../src/lib/utils/nasjonalbiblioteket.ts";

const item = {
  id: "da0b9c16",
  metadata: {
    title: "Sult",
    creators: ["Hamsun, Knut"],
    pageCount: 205,
    originInfo: { publisher: "Gyldendal", issued: "2009" },
    identifiers: { urn: "URN:NBN:no-nb_digibok_2016011906027" },
  },
};

test("a catalogue record parses into the metadata shape", () => {
  const parsed = parseNbItem(item, ["novel", "Romaner", "bibliography"]);
  assert.equal(parsed.title, "Sult");
  assert.deepEqual(parsed.authorNames, ["Knut Hamsun"]);
  assert.equal(parsed.pageCount, 205);
  assert.equal(parsed.publisher, "Gyldendal");
  assert.equal(parsed.publishedDate, "2009");
  assert.deepEqual(parsed.subjects, ["Romaner"]);
  assert.equal(parsed.fiction, true);
});

test("malformed optional catalogue fields degrade independently", () => {
  const parsed = parseNbItem({
    metadata: {
      title: 42,
      creators: ["Hamsun, Knut", null, 7],
      pageCount: "205",
      originInfo: { publisher: false, issued: ["2009"] },
      identifiers: { urn: 12 },
    },
  }, [null, " Romaner ", 8, "bibliography"]);
  assert.equal(parsed.title, "");
  assert.deepEqual(parsed.authorNames, ["Knut Hamsun"]);
  assert.equal(parsed.pageCount, undefined);
  assert.equal(parsed.publisher, "");
  assert.equal(parsed.publishedDate, "");
  assert.deepEqual(parsed.subjects, ["Romaner"]);
  assert.equal(parsed.fiction, true);
  assert.equal(parsed.urn, "");

  assert.deepEqual(parseNbItem({ metadata: { creators: "Wrong container" } }).authorNames, []);
  assert.equal(parseNbItem({ metadata: { pageCount: Number.NaN } }).pageCount, undefined);
});

test("a catalogue item must be an object", () => {
  assert.throws(() => parseNbItem(null), /must be an object/);
  assert.throws(() => parseNbItem([]), /must be an object/);
});

test("Nasjonalbiblioteket rejects non-positive, fractional, and unsafe page counts", () => {
  for (const pageCount of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseNbItem({ metadata: { pageCount } }).pageCount, undefined);
  }
});

test("a sanitized public cover can accompany the catalogue item", () => {
  assert.equal(parseNbItem(item, []).coverUrl, "");
  assert.equal(
    parseNbItem(item, [], "https://media.aja.bs.no/cover/original.jpg").coverUrl,
    "https://media.aja.bs.no/cover/original.jpg",
  );

  // In-copyright NB scans can return 403; the migration verifies this
  // separate candidate before storing it.
  assert.equal(
    nbCoverCandidate("URN:NBN:no-nb_digibok_2016011906027"),
    "https://www.nb.no/services/image/resolver/URN:NBN:no-nb_digibok_2016011906027_C1/full/0,400/0/native.jpg",
  );
  assert.equal(nbCoverCandidate(""), "");
});

test("catalogue names flip into display order", () => {
  assert.equal(flipCatalogueName("Hamsun, Knut"), "Knut Hamsun");
  assert.equal(flipCatalogueName("Stortinget"), "Stortinget");
  // Anything unexpected is left alone rather than mangled.
  assert.equal(flipCatalogueName("Tolkien, J.R.R., red."), "Tolkien, J.R.R., red.");
});

test("Norwegian fiction genres classify as fiction", () => {
  assert.equal(deriveFictionFromNbGenres(["novel", "Romaner"]), true);
  assert.equal(deriveFictionFromNbGenres(["Skuespill"]), true);
  assert.equal(deriveFictionFromNbGenres(["fiction", "tekst"]), true);
});

test("the explicit notfiction marker classifies as non-fiction", () => {
  assert.equal(deriveFictionFromNbGenres(["biography", "notfiction", "Selvbiografier"]), false);
  assert.equal(deriveFictionFromNbGenres(["Lover"]), false);
});

test("a content genre outranks a bibliographic form note", () => {
  // Real record: Sult carries novel + Romaner + bibliography.
  assert.equal(deriveFictionFromNbGenres(["novel", "Romaner", "bibliography"]), true);
});

test("cataloguing tokens alone say nothing", () => {
  assert.equal(deriveFictionFromNbGenres(["tekst", "bibliography"]), null);
  assert.equal(deriveFictionFromNbGenres([]), null);
});

test("MODS genres are extracted and de-duplicated", () => {
  const xml = `<mods:mods><mods:genre authority="x">novel</mods:genre>
    <mods:genre>novel</mods:genre><mods:genre>Romaner</mods:genre>
    <mods:genre></mods:genre></mods:mods>`;
  assert.deepEqual(extractModsGenres(xml), ["novel", "Romaner"]);
  assert.deepEqual(extractModsGenres("<genre>drama</genre>"), ["drama"]);
});

test("Kongeriket Norges grunnlov gets its explicit public MODS cover", () => {
  const xml = `<mods xmlns="http://www.loc.gov/mods/v3">
    <location><url displayLabel="Fulltekst Nettbiblioteket">https://www.nb.no/book</url></location>
    <location><url displayLabel="Omslagsbilde">https://media.aja.bs.no/6983b330-7c13-4505-86ac-7ece3ac0155f/original.jpg</url></location>
    <relatedItem><location><url displayLabel="Omslagsbilde">https://contents.bibs.aws.unit.no/files/images/large/1/7/9788245089271.jpg</url></location></relatedItem>
  </mods>`;
  const coverUrl = extractModsCoverUrl(xml);
  assert.equal(
    coverUrl,
    "https://media.aja.bs.no/6983b330-7c13-4505-86ac-7ece3ac0155f/original.jpg",
  );
  assert.equal(parseNbItem(item, ["notfiction", "Lover"], coverUrl).coverUrl, coverUrl);
});

test("MODS cover extraction rejects restricted, unlabelled, and foreign URLs", () => {
  assert.equal(
    extractModsCoverUrl('<url displayLabel="Omslagsbilde">https://www.nb.no/restricted.jpg</url>'),
    "",
  );
  assert.equal(
    extractModsCoverUrl('<url>https://media.aja.bs.no/unlabelled.jpg</url>'),
    "",
  );
  assert.equal(
    extractModsCoverUrl('<url displayLabel="Omslagsbilde">https://example.com/wrong.jpg</url>'),
    "",
  );
  assert.equal(
    extractModsCoverUrl('<mods:url displayLabel="Omslagsbilde">http://media.aja.bs.no/insecure.jpg</mods:url>'),
    "",
  );
});

test("the MODS language term is the text's language, stored as the catalog's code", () => {
  const mods = `<mods:mods><mods:language><mods:languageTerm type="code" authority="iso639-2b">nob</mods:languageTerm></mods:language>
    <mods:language objectPart="translation"><mods:languageTerm type="code">eng</mods:languageTerm></mods:language></mods:mods>`;
  assert.equal(extractModsLanguage(mods), "nob");
  assert.equal(extractModsLanguage("<mods:mods><mods:genre>Romaner</mods:genre></mods:mods>"), "");
  assert.equal(extractModsLanguage('<languageTerm type="text">Norsk</languageTerm>'), "");
  assert.equal(parseNbItem({ metadata: { title: "Sult" } }, [], "", "nob").language, "no");
  assert.equal(parseNbItem({ metadata: { title: "Sult" } }, [], "", "nno").language, "nn");
  assert.equal(parseNbItem({ metadata: { title: "Sult" } }).language, "");
});
