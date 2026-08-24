import * as functions from "firebase-functions/v1";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {defineJsonSecret} from "firebase-functions/params";
import {
  decodeBooksApiVolume,
  decodeIsbnLookupRequest,
  GoogleVolumeInfo,
} from "./decoders";

interface FunctionConfig {
  booksapi: {
    key: string;
    url: string;
  };
}

const runtimeConfig =
  defineJsonSecret<FunctionConfig>("FUNCTIONS_CONFIG_EXPORT");
const db = getFirestore();

const LOOKUPS_PER_WINDOW = 60;
const LOOKUP_WINDOW_MS = 60 * 60 * 1000;

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

async function consumeLookupQuota(uid: string): Promise<void> {
  const quotaRef = db.doc(`users/${uid}/functionQuotas/booksApi`);
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(quotaRef);
    const data = snap.data();
    const windowStartedAt = data?.windowStartedAt;
    const count = data?.count;
    if (!(windowStartedAt instanceof Timestamp) ||
        typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
        windowStartedAt.toMillis() <= now.toMillis() - LOOKUP_WINDOW_MS) {
      tx.set(quotaRef, {windowStartedAt: now, count: 1});
      return;
    }
    if (count >= LOOKUPS_PER_WINDOW) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Google Books lookup limit reached. Try again later.",
      );
    }
    tx.update(quotaRef, {count: count + 1});
  });
}

// Callable, not onRequest: this proxies a metered API key, so it must not
// be reachable without an authenticated caller. (It replaces a public
// `searchisbn` endpoint that was deployed but never called by the app.)
// country is explicit because Google otherwise geolocates the Cloud
// Functions egress IP and can 403 volumes it will serve for a real market.
exports.lookupisbn = functions
  .runWith({secrets: [runtimeConfig]})
  .region("europe-west1")
  .https.onCall(async (
    data: unknown,
    context,
  ): Promise<{volume: GoogleVolumeInfo | null}> => {
    if (context.auth === undefined) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Sign in to look up book metadata.",
      );
    }

    // The client normalizes to a checksum-valid ISBN-13 before calling
    // (utils/isbn.ts); anything else is a bug or a hand-rolled request.
    const {isbn} = decodeIsbnLookupRequest(data, invalidArgument);
    await consumeLookupQuota(context.auth.uid);

    const {url, key} = runtimeConfig.value().booksapi;
    const response = await fetch(`${url}?key=${key}&q=isbn:${isbn}&country=NO`);

    if (!response.ok) {
      // Google emits transient 503s; surface it as retryable rather than
      // as an internal error so the client can say "try again".
      throw new functions.https.HttpsError(
        response.status >= 500 ? "unavailable" : "internal",
        `Google Books request failed with status ${response.status}.`,
      );
    }

    const result: unknown = await response.json();
    // No match is a normal answer, not an error: the caller merges
    // whatever it has from Open Library and moves on.
    return {volume: decodeBooksApiVolume(result)};
  });
