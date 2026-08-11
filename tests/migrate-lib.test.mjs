import assert from "node:assert/strict";
import test from "node:test";

import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint } from "firebase-admin/firestore";

import { parseFlags, encodeValue, decodeValue, batcher } from "../migrate-lib.js";

// Creating refs and batches needs an app but no network or credentials.
const app = initializeApp({ projectId: "book-tracker-d8f24" }, "migrate-lib-test");
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
  const decoded = decodeValue(db, JSON.parse(JSON.stringify(encodeValue(original))));
  assert.equal(decoded.title, "Book");
  assert.equal(decoded.nothing, null);
  assert.ok(decoded.at instanceof Timestamp);
  assert.equal(decoded.at.seconds, 1723300000);
  assert.equal(decoded.at.nanoseconds, 250);
  assert.equal(decoded.where.latitude, 59.9);
  assert.equal(decoded.raw.toString(), "bytes here");
  assert.equal(decoded.owner.path, "users/abc");
  assert.ok(decoded.nested.list[2] instanceof Timestamp);
  assert.equal(decoded.nested.list[3].deep.path, "users/abc/books/b1");
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
  await writer.flush();
  assert.equal(writer.count(), 750);
});

test("flags parse and unknown flags crash", () => {
  const flags = parseFlags(["snapshots/x.json", "--prod", "--apply", "--database=recovered"]);
  assert.deepEqual(flags, { prod: true, apply: true, database: "recovered", rest: ["snapshots/x.json"] });
  assert.throws(() => parseFlags(["--aply"]), /unknown flag/);
});
