import * as functions from "firebase-functions/v1";
import {getFirestore} from "firebase-admin/firestore";
import {defineJsonSecret} from "firebase-functions/params";
import {env} from "node:process";
import {
  decodeBooksApiVolume,
  decodeIsbnLookupRequest,
  GoogleVolumeInfo,
} from "./decoders";
import {consumeQuota} from "./quota";
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";

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
  const decision = await consumeQuota(
    db,
    `users/${uid}/functionQuotas/booksApi`,
    LOOKUPS_PER_WINDOW,
    LOOKUP_WINDOW_MS,
  );
  if (!decision.granted) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Google Books lookup limit reached. Try again later.",
    );
  }
}

// Callable, not onRequest: this proxies a metered API key, so it must not
// be reachable without an authenticated caller. (It replaces a public
// `searchisbn` endpoint that was deployed but never called by the app.)
// country is explicit because Google otherwise geolocates the Cloud
// Functions egress IP and can 403 volumes it will serve for a real market.
exports.lookupisbn = functions
  .runWith({
    secrets: [runtimeConfig],
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: CALLABLE_MAX_INSTANCES,
  })
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

    // Emulator rehearsals must not consume the production API key or quota.
    // Open Library and Nasjonalbiblioteket can still populate the client; a
    // null Google result exercises the normal partial-source merge path.
    if (env.FUNCTIONS_EMULATOR === "true") {
      return {volume: null};
    }

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
