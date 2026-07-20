import * as functions from "firebase-functions/v1";
import {defineJsonSecret} from "firebase-functions/params";
import * as https from "https";

interface FunctionConfig {
  booksapi: {
    key: string;
    url: string;
  };
}

interface BookApiResponseItem {
  publishedDate: string;
  description: string;
  industryIdentifiers: [
    {
      type: "ISBN_13";
      identifier: string;
    }
  ];
  pageCount: number;
  printType: string;
  categories: string[];
  averageRating: number;
  ratingsCount: number;
  imageLinks: {
    smallThumbnail: string;
    thumbnail: string;
  };
  language: string;
  previewLink: string;
  infoLink: string;
  canonicalVolumeLink: string;
}

interface BookApiResponse {
  totalItems: number;
  items: BookApiResponseItem[];
}

const runtimeConfig =
  defineJsonSecret<FunctionConfig>("FUNCTIONS_CONFIG_EXPORT");

async function getBooks(isbn: string): Promise<BookApiResponse> {
  const {url, key} = runtimeConfig.value().booksapi;

  return new Promise((resolve) => {
    let data = "";
    const fullUrl = `${url}?key=${key}&q=isbn:${isbn}&country=NO`;
    https.get(fullUrl, (res) => {
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve(JSON.parse(data));
      });
    });
  });
}

exports.searchisbn = functions
  .runWith({secrets: [runtimeConfig]})
  .region("europe-west1")
  .https.onRequest(async (req, resp) => {
    const { isbn } = req.query;

    if (isbn === undefined) {
      resp.send("No isbn query supplied");
      return;
    }

    if (typeof isbn !== "string") {
      resp.send("isbn query must be string");
      return;
    }

    const result = await getBooks(isbn);

    if (result.totalItems < 1) {
      resp.statusCode = 400;
      resp.send(
        JSON.stringify({message: "Book not found for that ISBN number"}),
      );

      return;
    }

    resp.send(JSON.stringify(result.items[0]));

    return;
  });
