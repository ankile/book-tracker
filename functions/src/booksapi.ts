import * as functions from "firebase-functions/v1";
import {getFirestore} from "firebase-admin/firestore";
import {defineJsonSecret} from "firebase-functions/params";
import {env} from "node:process";
import {setTimeout as delay} from "node:timers/promises";
import {
  decodeBooksApiVolume,
  decodeIsbnLookupRequest,
  GoogleVolumeInfo,
} from "./decoders";
import {consumeQuota} from "./quota";
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {logAppCheckPresence} from "./appCheck";

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
const GOOGLE_BOOKS_MAX_ATTEMPTS = 4;
const GOOGLE_BOOKS_RETRY_BASE_MS = 250;

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

function retryableGoogleBooksStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchGoogleBooks(url: string): Promise<Response> {
  let response = await fetch(url);
  for (let attempt = 1;
    attempt < GOOGLE_BOOKS_MAX_ATTEMPTS &&
    retryableGoogleBooksStatus(response.status);
    attempt += 1) {
    await delay(GOOGLE_BOOKS_RETRY_BASE_MS * 2 ** (attempt - 1));
    response = await fetch(url);
  }
  return response;
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
    enforceAppCheck: true,
  })
  .region("europe-west1")
  .https.onCall(async (
    data: unknown,
    context,
  ): Promise<{volume: GoogleVolumeInfo | null}> => {
    logAppCheckPresence("booksapi.lookupisbn", context);
    if (context.auth === undefined) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Sign in to look up book metadata.",
      );
    }
    if (context.auth.token.email_verified !== true) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Verify your email before looking up book metadata.",
      );
    }

    // The client normalizes to a checksum-valid ISBN-13 before calling
    // (utils/isbn.ts); anything else is a bug or a hand-rolled request.
    const {isbn} = decodeIsbnLookupRequest(data, invalidArgument);
    const uid = context.auth.uid;
    const user = await db.collection("users").doc(uid).get();
    if (!user.exists || user.get("deletedAt") !== undefined) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This account is not active.",
      );
    }
    await consumeLookupQuota(uid);

    // Emulator rehearsals must not consume the production API key or quota.
    // Open Library and Nasjonalbiblioteket can still populate the client; a
    // null Google result exercises the normal partial-source merge path.
    if (env.FUNCTIONS_EMULATOR === "true") {
      return {volume: null};
    }

    const {url, key} = runtimeConfig.value().booksapi;
    const response = await fetchGoogleBooks(
      `${url}?key=${key}&q=isbn:${isbn}&country=NO`,
    );

    if (!response.ok) {
      // The short retry budget has been exhausted. Keep transient upstream
      // failures retryable for a later button press.
      throw new functions.https.HttpsError(
        retryableGoogleBooksStatus(response.status) ?
          "unavailable" : "internal",
        `Google Books request failed with status ${response.status}.`,
      );
    }

    const result: unknown = await response.json();
    // No match is a normal answer, not an error: the caller merges
    // whatever it has from Open Library and moves on.
    return {volume: decodeBooksApiVolume(result)};
  });
