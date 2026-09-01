// Shared decoder primitives for callable responses decoded in the browser
// (catalogClient.ts, adminCatalog.ts). Every primitive throws a TypeError with
// the caller's context prefix; nothing here falls back to a default value.
// src/lib/firebase/decoders.ts is deliberately NOT built on these: it throws
// DataDecodeError, tolerates undefined and treats extra keys as allowed.
import type { EditionFormat } from '../interfaces/catalog.ts';

export type Data = Record<string, unknown>;

export function record(value: unknown, context: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context}: expected an object`);
  }
  return value as Data;
}

export function exactKeys(value: Data, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${context}: expected only ${expected.join(', ')}`);
  }
}

export function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new TypeError(`${context}: expected a string`);
  return value;
}

export function nonEmptyString(value: unknown, context: string): string {
  const decoded = string(value, context);
  if (decoded.length === 0) throw new TypeError(`${context}: expected a non-empty string`);
  return decoded;
}

export function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : nonEmptyString(value, context);
}

export function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${context}: expected a boolean`);
  return value;
}

export function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context}: expected a finite number`);
  }
  return value;
}

export function nullableNumber(value: unknown, context: string): number | null {
  return value === null ? null : finiteNumber(value, context);
}

export function integer(value: unknown, context: string): number {
  const decoded = finiteNumber(value, context);
  if (!Number.isSafeInteger(decoded)) throw new TypeError(`${context}: expected a safe integer`);
  return decoded;
}

export function strings(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${context}: expected an array`);
  return value.map((entry, index) => string(entry, `${context}[${index}]`));
}

export function editionFormat(value: unknown, context: string): EditionFormat {
  if (value !== 'full' && value !== 'abridged' && value !== 'revised' && value !== 'unknown') {
    throw new TypeError(`${context}: expected a supported edition format`);
  }
  return value;
}
