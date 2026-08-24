import * as functions from "firebase-functions/v1";
import {defineJsonSecret} from "firebase-functions/params";

interface FunctionConfig {
  booksapi: {
    key: string;
    url: string;
  };
}

// The subset of Google Books' volumeInfo the client parses (see
// src/lib/utils/googleBooks.js). Returned verbatim rather than reshaped
// here so the parsing rules — including the fiction/non-fiction call —
// live in one tested place shared with the backfill migrations.
interface VolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  categories?: string[];
  imageLinks?: {
    smallThumbnail?: string;
    thumbnail?: string;
  };
}

interface BooksApiResponse {
  totalItems: number;
  items?: { volumeInfo: VolumeInfo }[];
}

const runtimeConfig =
  defineJsonSecret<FunctionConfig>("FUNCTIONS_CONFIG_EXPORT");

// Callable, not onRequest: this proxies a metered API key, so it must not
// be reachable without an authenticated caller. (It replaces a public
// `searchisbn` endpoint that was deployed but never called by the app.)
// country is explicit because Google otherwise geolocates the Cloud
// Functions egress IP and can 403 volumes it will serve for a real market.
exports.lookupisbn = functions
  .runWith({secrets: [runtimeConfig]})
  .region("europe-west1")
  .https.onCall(async (data, context): Promise<{volume: VolumeInfo | null}> => {
    if (context.auth === undefined) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Sign in to look up book metadata.",
      );
    }

    const isbn: unknown = data?.isbn;
    // The client normalizes to a checksum-valid ISBN-13 before calling
    // (utils/isbn.js); anything else is a bug or a hand-rolled request.
    if (typeof isbn !== "string" || !/^\d{13}$/.test(isbn)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "isbn must be a 13-digit ISBN-13 string.",
      );
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

    const result = await response.json() as BooksApiResponse;
    // No match is a normal answer, not an error: the caller merges
    // whatever it has from Open Library and moves on.
    return {volume: result.items?.[0]?.volumeInfo ?? null};
  });
