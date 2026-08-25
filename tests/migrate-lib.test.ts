import assert from "node:assert/strict";
import test from "node:test";

import { initializeApp } from "firebase-admin/app";
import {
  DocumentReference,
  getFirestore,
  Timestamp,
  GeoPoint,
} from "firebase-admin/firestore";

import {
  parseFlags,
  encodeValue,
  decodeValue,
  batcher,
  type DecodedDocument,
} from "../migrate-lib.ts";
import {
  restoreCompletionBanner,
  restoreStartBanner,
} from "../db-restore-messages.ts";

// Creating refs and batches needs an app but no network or credentials.
const app = initializeApp({ projectId: "book-tracker-test" }, "migrate-lib-test");
const db = getFirestore(app);

test("codec round-trips every Firestore field type", () => {
  const original = {
    title: "Book",
    pages: 300,
    done: false,
    nothing: null,
    at: new Timestamp(1723300000, 250),
    where: new GeoPoint(59.9, 10.7),
    raw: Buffer.from("bytes here"),
    owner: db.doc("users/abc"),
    nested: { list: [1, "two", new Timestamp(5, 6), { deep: db.doc("users/abc/books/b1") }] },
  };
  const decoded = decodeValue(
    db,
    JSON.parse(JSON.stringify(encodeValue(original))),
  ) as DecodedDocument;
  assert.equal(decoded.title, "Book");
  assert.equal(decoded.nothing, null);
  assert.ok(decoded.at instanceof Timestamp);
  assert.equal(decoded.at.seconds, 1723300000);
  assert.equal(decoded.at.nanoseconds, 250);
  assert.ok(decoded.where instanceof GeoPoint);
  assert.equal(decoded.where.latitude, 59.9);
  assert.ok(Buffer.isBuffer(decoded.raw));
  assert.equal(decoded.raw.toString(), "bytes here");
  assert.ok(decoded.owner instanceof DocumentReference);
  assert.equal(decoded.owner.path, "users/abc");
  assert.ok(
    typeof decoded.nested === "object" &&
      decoded.nested !== null &&
      !Array.isArray(decoded.nested),
  );
  const nested = decoded.nested as DecodedDocument;
  assert.ok(Array.isArray(nested.list));
  assert.ok(nested.list[2] instanceof Timestamp);
  const deep = nested.list[3];
  assert.ok(typeof deep === "object" && deep !== null && !Array.isArray(deep));
  const deepDocument = deep as DecodedDocument;
  assert.ok(deepDocument.deep instanceof DocumentReference);
  assert.equal(deepDocument.deep.path, "users/abc/books/b1");
});

test("encoder crashes on unknown object types", () => {
  assert.throws(() => encodeValue({ bad: new Date() }), /unhandled type Date/);
});

test("encoder crashes on the reserved __type key", () => {
  assert.throws(() => encodeValue({ __type: "sneaky" }), /reserved key/);
});

test("decoder crashes on unknown __type markers", () => {
  assert.throws(() => decodeValue(db, { __type: "hologram" }), /unknown __type/);
});

test("batcher update refuses updatedAt", async () => {
  const writer = batcher(db, { apply: false });
  await assert.rejects(
    () => writer.update(db.doc("users/abc/books/b1"), { updatedAt: Timestamp.now() }),
    /touches updatedAt/,
  );
});

test("batcher set allows updatedAt and dry-run counts without committing", async () => {
  const writer = batcher(db, { apply: false });
  for (let i = 0; i < 750; i++) {
    await writer.set(db.doc(`users/abc/authors/a${i}`), { updatedAt: Timestamp.now() });
  }
  await writer.delete(db.doc("users/abc/authors/gone"));
  await writer.flush();
  assert.equal(writer.count(), 751);
});

test("flags parse and unknown flags crash", () => {
  const flags = parseFlags(["snapshots/x.json", "--prod", "--apply", "--database=recovered"]);
  assert.deepEqual(flags, { prod: true, apply: true, database: "recovered", rest: ["snapshots/x.json"] });
  assert.throws(() => parseFlags(["--aply"]), /unknown flag/);
  assert.throws(() => parseFlags(["--database="]), /database id must not be empty/);
});

test("restore dry-run banners say nothing was written and give the exact apply command", () => {
  const options = {
    file: "snapshots/reader's copy.json",
    flags: { prod: false, apply: false, database: undefined },
  };
  const start = restoreStartBanner(options);
  const end = restoreCompletionBanner({ ...options, documents: 12, skipped: 2 });

  assert.match(start, /DRY RUN ONLY — NOTHING WRITTEN; NOTHING WILL BE WRITTEN/);
  assert.match(end, /DRY RUN COMPLETE — NOTHING WRITTEN/);
  assert.match(end, /No restore was applied/);
  assert.match(start, /node db-restore\.ts 'snapshots\/reader'"'"'s copy\.json' --apply/);
  assert.doesNotMatch(start, /--prod/);
  assert.match(end, /12 documents checked/);
});

test("production dry-run calls out --prod muscle memory and typed apply confirmation", () => {
  const options = {
    file: "snapshots/prod.json",
    flags: { prod: true, apply: false, database: "recovered" },
  };
  const start = restoreStartBanner(options);
  const end = restoreCompletionBanner({ ...options, documents: 20, skipped: 1 });

  for (const output of [start, end]) {
    assert.match(output, /node db-restore\.ts 'snapshots\/prod\.json' --prod --apply --database='recovered'/);
    assert.match(output, /typing book-tracker-d8f24/);
  }
  assert.match(start, /--prod selected the production target only\. It did NOT enable writes/);
  assert.match(start, /DRY RUN ONLY — NOTHING WRITTEN; NOTHING WILL BE WRITTEN/);
  assert.match(end, /DRY RUN COMPLETE — NOTHING WRITTEN/);
});

test("restore apply banners state that writes are enabled and completed", () => {
  const options = {
    file: "snapshots/prod.json",
    flags: { prod: true, apply: true, database: undefined },
  };
  const start = restoreStartBanner(options);
  const end = restoreCompletionBanner({ ...options, documents: 20, skipped: 1 });

  assert.match(start, /APPLY MODE — WRITES ARE ENABLED/);
  assert.match(start, /Typed confirmation for book-tracker-d8f24 is required/);
  assert.match(end, /APPLY COMPLETE — 20 DOCUMENTS WRITTEN/);
  assert.doesNotMatch(end, /NOTHING WRITTEN/);
  assert.doesNotMatch(end, /No restore was applied/);
});
