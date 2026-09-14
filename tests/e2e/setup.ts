import { readFile } from "node:fs/promises";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

export default async function setup(): Promise<void> {
  if (
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099"
  )
    throw new Error(
      "Browser tests require the local Auth and Firestore emulators.",
    );
  // firebase-tools currently starts the multi-database configuration with
  // permissive default-database Rules. Browser tests must exercise the same
  // authorization boundary as production, including rejected offline batches.
  const env = await initializeTestEnvironment({
    projectId: "book-tracker-d8f24",
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: await readFile(
        new URL("../../firestore.rules", import.meta.url),
        "utf8",
      ),
    },
  });
  await env.cleanup();
}
