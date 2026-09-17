/**
 * Canonical representation and lossless JSON helpers for Wise identifiers.
 *
 * Wise documents transfer, recipient, user, profile, balance and related identifiers as signed
 * 64-bit integers (https://docs.wise.com/changelog/int64-changes). JavaScript `number` is only exact
 * up to `Number.MAX_SAFE_INTEGER`, so we carry these identifiers as opaque decimal strings
 * everywhere (domain objects, JSONB, caches, logs, GraphQL, frontend state).
 *
 * `parseLosslessJson`/`stringifyLosslessJson` build on the maintained `lossless-json` tokenizer to
 * preserve those digits while reading HTTP responses (and verified webhook raw bodies) and to emit
 * exact unquoted int64 tokens when sending requests back to Wise.
 */

import { LosslessNumber, parse, stringify } from 'lossless-json';

export type WiseId = string;

const DECIMAL_ID = /^-?\d+$/;

/**
 * Returns the canonical (no leading zeros) decimal string for a Wise identifier.
 *
 * Accepts exact decimal strings, `bigint` and safe integer `number`s. Unsafe `number`s are rejected
 * because their original digits cannot be proven.
 */
export function normalizeWiseId(value: unknown): WiseId {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL_ID.test(trimmed)) {
      throw new Error(`Invalid Wise identifier: ${JSON.stringify(value)}`);
    }
    return BigInt(trimmed).toString();
  } else if (typeof value === 'bigint') {
    return value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Refusing to use an unsafe Number as a Wise identifier (${value}). Use a decimal string instead.`,
      );
    }
    return value.toString();
  } else {
    throw new Error(`Invalid Wise identifier type: ${typeof value}`);
  }
}

/** Canonicalizes an optional Wise identifier, leaving `null`/`undefined` untouched. */
export function normalizeOptionalWiseId(value: unknown): WiseId | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeWiseId(value);
}

/** Same as `normalizeWiseId` but returns `null` instead of throwing. */
export function tryNormalizeWiseId(value: unknown): WiseId | null {
  try {
    return normalizeWiseId(value);
  } catch {
    return null;
  }
}

/** Compares two Wise identifiers regardless of their legacy numeric / canonical string representation. */
export function wiseIdsEqual(a: unknown, b: unknown): boolean {
  const normalizedA = tryNormalizeWiseId(a);
  return normalizedA !== null && normalizedA === tryNormalizeWiseId(b);
}

/** Normalizes a list of Wise identifiers, dropping invalid/empty entries. */
export function normalizeWiseIdList(values: unknown): WiseId[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map(tryNormalizeWiseId).filter((value): value is WiseId => value !== null);
}

/** Whether a list of Wise identifiers (mixed legacy numeric / string) contains the given identifier. */
export function wiseIdListIncludes(values: unknown, id: unknown): boolean {
  const normalizedId = tryNormalizeWiseId(id);
  if (normalizedId === null) {
    return false;
  }
  return normalizeWiseIdList(values).includes(normalizedId);
}

/**
 * Legacy connected-account hashes were derived from Wise IDs parsed as JavaScript numbers. To keep
 * finding (and not duplicating) historical connected accounts, hashes must keep being computed from
 * the same numeric representation. Values above `Number.MAX_SAFE_INTEGER` round the same way they
 * did before, so the resulting fingerprint stays stable.
 */
export function legacyNumericWiseId(value: unknown): number {
  return Number(normalizeWiseId(value));
}

const INTEGER_TOKEN = /^-?\d+$/;

/**
 * Number parser for `lossless-json`: integer tokens above `Number.MAX_SAFE_INTEGER` are returned as
 * decimal strings (exact digits), everything else delegates to `Number` like `JSON.parse` does.
 */
function parseWiseNumber(value: string): number | string {
  if (INTEGER_TOKEN.test(value) && !Number.isSafeInteger(Number(value))) {
    return value;
  }
  return Number(value);
}

/** Parses JSON without rounding integers above `Number.MAX_SAFE_INTEGER` (they become decimal strings). */
export function parseLosslessJson<T = unknown>(text: string): T {
  return parse(text, null, { parseNumber: parseWiseNumber }) as T;
}

/** Wraps a Wise identifier so `stringifyLosslessJson` emits it as an exact unquoted int64. */
export function wiseInt64(value: string | number | bigint | null | undefined): LosslessNumber | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return new LosslessNumber(normalizeWiseId(value));
}

/**
 * Serializes a value like `JSON.stringify`, preserving `LosslessNumber` and `bigint` values as exact
 * unquoted integer tokens.
 */
export function stringifyLosslessJson(value: unknown, space?: number | string): string | undefined {
  return stringify(value, null, space);
}
