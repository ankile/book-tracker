import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const fixturePath = resolve(".secret.emulator");
const localPath = resolve(".secret.local");
const fixture = readFileSync(fixturePath, "utf8");

if (existsSync(localPath)) {
  if (readFileSync(localPath, "utf8") !== fixture) {
    throw new Error(
      ".secret.local differs from the safe emulator fixture. " +
      "Move it aside before starting the emulators.",
    );
  }
} else {
  writeFileSync(localPath, fixture, {encoding: "utf8", flag: "wx"});
}
