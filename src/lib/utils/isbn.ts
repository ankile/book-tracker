// ISBN normalization, shared by the add/edit modal's Look up button and
// migrate-enrich-books.ts so both key Open Library lookups the same way.
//
// normalizeIsbn accepts whatever the user pasted (hyphens, spaces, lower-x
// check digit) and returns the bare ISBN-13 string, converting ISBN-10
// input. Returns null for anything that isn't a checksum-valid ISBN —
// callers surface that, they don't guess.
export function normalizeIsbn(raw: string): string | null {
  const s = raw.replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      sum += (10 - i) * (s[i] === "X" ? 10 : Number(s[i]));
    }
    if (sum % 11 !== 0) return null;
    const core = `978${s.slice(0, 9)}`;
    return core + isbn13CheckDigit(core);
  }
  if (/^\d{13}$/.test(s)) {
    return s[12] === isbn13CheckDigit(s.slice(0, 12)) ? s : null;
  }
  return null;
}

function isbn13CheckDigit(digits12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}
