require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");

type ConsentSnapshot = import("../src/sharingConsent").ConsentSnapshot;
const consent: typeof import("../src/sharingConsent") = require("../lib/sharingConsent");

function snapshot(data: Record<string, unknown> | undefined): ConsentSnapshot {
  return {
    exists: data !== undefined,
    get: (field: string) => data?.[field],
  };
}

// Browsers store resolvedOptions().timeZone verbatim, and the Rules regex
// accepts every one of these; a validator built from
// Intl.supportedValuesOf("timeZone") rejected the first three on Node 22
// and hid the reader without a log line.
test("time zone validation accepts the aliases browsers report", () => {
  for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "Etc/UTC", "UTC",
    "America/Argentina/Buenos_Aires", "America/Los_Angeles"]) {
    assert.equal(consent.validTimeZone(zone), true, zone);
  }
  for (const zone of ["Mars/Olympus_Mons", "", "utc ", 7, null, undefined]) {
    assert.equal(consent.validTimeZone(zone), false, String(zone));
  }
});

// Sharing is on by default: a live account with no setting shares in UTC;
// only an explicit opt-out (or a setting too malformed to read as consent)
// withdraws it, and a tombstoned or missing account never shares.
test("a live account shares unless it opted out; the setting only refines the time zone", () => {
  const live = snapshot({uid: "reader"});
  assert.deepEqual(consent.sharingConsent(live, snapshot(undefined)), {timeZone: "UTC"});
  assert.deepEqual(
    consent.sharingConsent(live, snapshot({enabled: true, timeZone: "Asia/Kolkata"})),
    {timeZone: "Asia/Kolkata"},
  );
  assert.deepEqual(
    consent.sharingConsent(live, snapshot({enabled: true, timeZone: "Nowhere/Land"})),
    {timeZone: "UTC"},
  );
  assert.equal(consent.sharingConsent(live, snapshot({enabled: false, timeZone: "UTC"})), null);
  for (const malformed of [{timeZone: "UTC"}, {enabled: "true", timeZone: "UTC"}, {enabled: 1}]) {
    assert.equal(consent.sharingConsent(live, snapshot(malformed)), null, JSON.stringify(malformed));
  }
  assert.equal(consent.sharingConsent(snapshot(undefined), snapshot(undefined)), null);
  assert.equal(consent.sharingConsent(snapshot({deletedAt: 1}), snapshot(undefined)), null);
  assert.equal(
    consent.sharingConsent(snapshot({deletedAt: 1}), snapshot({enabled: true, timeZone: "UTC"})),
    null,
  );
});

// Identity is separate from consent: a public profile the account still
// owns names the reader; anything else leaves them anonymous, not hidden.
test("a reader is named only by a public profile the account still owns", () => {
  const profile = {uid: "reader", public: true, givenName: "Ada", familyName: "Reader"};
  assert.deepEqual(consent.readerIdentity(snapshot(profile), "reader", "ada-reader"), {
    username: "ada-reader",
    displayName: "Ada Reader",
  });
  assert.equal(consent.readerIdentity(snapshot(profile), "reader", undefined), null);
  assert.equal(consent.readerIdentity(snapshot(profile), "reader", "Ada Reader"), null);
  assert.equal(consent.readerIdentity(snapshot(undefined), "reader", "ada-reader"), null);
  assert.equal(consent.readerIdentity(snapshot({...profile, uid: "other"}), "reader", "ada-reader"), null);
  assert.equal(consent.readerIdentity(snapshot({...profile, public: false}), "reader", "ada-reader"), null);
  assert.equal(consent.readerIdentity(snapshot({...profile, public: "true"}), "reader", "ada-reader"), null);
  assert.equal(consent.readerIdentity(snapshot({...profile, deletedAt: 1}), "reader", "ada-reader"), null);
  assert.equal(consent.readerIdentity(snapshot({...profile, givenName: 7}), "reader", "ada-reader"), null);
  assert.equal(
    consent.readerIdentity(snapshot({...profile, givenName: " ", familyName: ""}), "reader", "ada-reader"),
    null,
  );
});
