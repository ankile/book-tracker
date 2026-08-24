import assert from "node:assert/strict";
import test from "node:test";

import { linkHref, linkDisplay, linkTypeName } from "../src/lib/utils/links.js";

test("bare handles get the platform prefix, @ stripped", () => {
  assert.equal(linkHref({ type: "twitter", value: "@ankile" }), "https://x.com/ankile");
  assert.equal(linkHref({ type: "github", value: "ankile" }), "https://github.com/ankile");
  assert.equal(linkHref({ type: "strava", value: "12345" }), "https://www.strava.com/athletes/12345");
});

test("full URLs pass through untouched", () => {
  assert.equal(
    linkHref({ type: "homepage", value: "https://ankile.com/about" }),
    "https://ankile.com/about"
  );
});

test("a value can never smuggle in its own scheme", () => {
  // Not http(s), so it's treated as a handle and prefixed — the href
  // scheme is always https.
  assert.equal(
    linkHref({ type: "other", value: "javascript:alert(1)" }),
    "https://javascript:alert(1)"
  );
  assert.ok(linkHref({ type: "homepage", value: "data:text/html,x" }).startsWith("https://"));
});

test("display text prefers the custom label and strips scheme noise", () => {
  assert.equal(linkDisplay({ type: "other", label: "Blog", value: "https://blog.example.com/" }), "Blog");
  assert.equal(linkDisplay({ type: "homepage", value: "https://ankile.com/" }), "ankile.com");
  assert.equal(linkTypeName({ type: "scholar", value: "abc" }), "Google Scholar");
  assert.equal(linkTypeName({ type: "other", label: "Blog", value: "x" }), "Blog");
});
