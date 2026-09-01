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

test("a sharing setting counts only for a live account with a well-formed row", () => {
  const live = snapshot({uid: "reader"});
  const setting = snapshot({profileUsername: "ada-reader", timeZone: "Asia/Kolkata"});
  assert.deepEqual(consent.sharingSetting(live, setting), {
    username: "ada-reader",
    timeZone: "Asia/Kolkata",
  });
  assert.equal(consent.sharingSetting(snapshot(undefined), setting), null);
  assert.equal(consent.sharingSetting(snapshot({deletedAt: 1}), setting), null);
  assert.equal(consent.sharingSetting(live, snapshot(undefined)), null);
  for (const broken of [
    {profileUsername: "Ada Reader", timeZone: "UTC"},
    {profileUsername: "ab", timeZone: "UTC"},
    {profileUsername: "ada-reader", timeZone: "Nowhere/Land"},
    {profileUsername: "ada-reader"},
    {timeZone: "UTC"},
  ]) {
    assert.equal(consent.sharingSetting(live, snapshot(broken)), null, JSON.stringify(broken));
  }
});

test("the named profile must still be the account's and public", () => {
  assert.equal(consent.profileConsents(snapshot({uid: "reader", public: true}), "reader"), true);
  assert.equal(consent.profileConsents(snapshot(undefined), "reader"), false);
  assert.equal(consent.profileConsents(snapshot({uid: "other", public: true}), "reader"), false);
  assert.equal(consent.profileConsents(snapshot({uid: "reader", public: false}), "reader"), false);
  assert.equal(consent.profileConsents(snapshot({uid: "reader", public: "true"}), "reader"), false);
  assert.equal(
    consent.profileConsents(snapshot({uid: "reader", public: true, deletedAt: 1}), "reader"),
    false,
  );
});
