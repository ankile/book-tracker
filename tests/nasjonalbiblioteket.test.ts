import assert from "node:assert/strict";
import test from "node:test";

import {
  parseNbItem, deriveFictionFromNbGenres, extractModsGenres, flipCatalogueName, nbCoverCandidate,
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

test("the cover is never taken on trust — parsing leaves it empty", () => {
  // In-copyright scans 403; migrate-enrich-nb.ts verifies the candidate.
  assert.equal(parseNbItem(item, []).coverUrl, "");
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
