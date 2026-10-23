/**
 * Parsing and limits for PostgreSQL search input. Everything here runs in JS before any SQL: user input only
 * reaches SQL as bound parameters, and tsquery syntax is only ever built from sanitized tokens.
 */

import { BadRequest } from '../../../../graphql/errors';
import { idDecode, idEncode, IdentifierType } from '../../../../graphql/v2/identifiers';
import { EntityShortIdPrefix, isAnyEntityPublicId, isEntityPublicId } from '../../../permalink/entity-map';

const PostgresSearchLimits = {
  MAX_TERM_LENGTH: 200,
  MAX_WORDS: 12,
  MAX_RESULTS_PER_PAGE: 50,
  MAX_OFFSET: 5000,
  /** Account name/slug prefixes */
  MIN_PREFIX_LENGTH: 2,
  /** Account name typos */
  MIN_TYPO_LENGTH: 3,
  /** Accepted range for the caller's `timeout` */
  MIN_TIMEOUT_MS: 100,
  MAX_TIMEOUT_MS: 30_000,
} as const;

const MAX_INT4 = 2_147_483_647;

export type ParsedSearchInput = {
  /** Trimmed input, used for ordinary words (`plainto_tsquery`) and normalized labels (SQL-side normalization) */
  term: string;
  /** Letters/digits tokens, lowercased */
  tokens: string[];
  /** `tok1:* & tok2:*` built from tokens, or null if the input is too short for prefix matching */
  prefixQuery: string | null;
  /** Whether typo matching applies (long enough input) */
  allowTypos: boolean;
  /** Input as a slug (`@slug` or `Slug Words` -> `slug-words`) */
  slug: string | null;
  /** Typed exact identifiers parsed from the input. Adapters only use the ones that apply to their entity. */
  identifiers: {
    /** `123` or `#123`, within the int4 range */
    id: number | null;
    /** A public ID (`acc_xxx`, `ex_xxx`...) */
    publicId: string | null;
  };
};

const tokenize = (term: string): string[] =>
  term
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const parseIntegerId = (term: string): number | null => {
  const match = term.match(/^#?(\d{1,10})$/);
  if (!match) {
    return null;
  }

  const id = Number(match[1]);
  return id > 0 && id <= MAX_INT4 ? id : null;
};

/**
 * Throws if the input exceeds the supported size. Applies to all entities of a search.
 */
export const assertValidSearchTerm = (rawTerm: string): void => {
  const term = rawTerm.trim();
  if (term.length > PostgresSearchLimits.MAX_TERM_LENGTH) {
    throw new BadRequest(
      `The search term is too long (maximum ${PostgresSearchLimits.MAX_TERM_LENGTH} characters)`,
      'SearchTermTooLong',
    );
  }

  const wordsCount = term.split(/\s+/).filter(Boolean).length;
  if (wordsCount > PostgresSearchLimits.MAX_WORDS) {
    throw new BadRequest(
      `The search term has too many words (maximum ${PostgresSearchLimits.MAX_WORDS})`,
      'SearchTermTooManyWords',
    );
  }
};

export const assertValidSearchTimeout = (timeoutInMs: number): void => {
  if (
    !Number.isInteger(timeoutInMs) ||
    timeoutInMs < PostgresSearchLimits.MIN_TIMEOUT_MS ||
    timeoutInMs > PostgresSearchLimits.MAX_TIMEOUT_MS
  ) {
    throw new BadRequest(
      `The search timeout must be between ${PostgresSearchLimits.MIN_TIMEOUT_MS} and ${PostgresSearchLimits.MAX_TIMEOUT_MS} ms`,
      'SearchInvalidTimeout',
    );
  }
};

/**
 * Throws if an entity page exceeds the supported depth. A limit of 0 only returns the total and the maximum score.
 */
export const assertValidSearchPage = ({ limit, offset }: { limit: number; offset: number }): void => {
  if (!Number.isInteger(limit) || limit < 0 || limit > PostgresSearchLimits.MAX_RESULTS_PER_PAGE) {
    throw new BadRequest(
      `The search limit must be between 0 and ${PostgresSearchLimits.MAX_RESULTS_PER_PAGE}`,
      'SearchInvalidLimit',
    );
  } else if (!Number.isInteger(offset) || offset < 0 || offset > PostgresSearchLimits.MAX_OFFSET) {
    throw new BadRequest(
      `Search results are only available up to offset ${PostgresSearchLimits.MAX_OFFSET}. Narrow your search to see more results.`,
      'SearchOffsetTooDeep',
    );
  }
};

export const parseSearchInput = (rawTerm: string): ParsedSearchInput => {
  // PostgreSQL text can't contain NUL characters: binding one fails the whole statement (invalid byte sequence)
  const term = rawTerm.replace(/\0/g, ' ').trim();
  const tokens = tokenize(term).slice(0, PostgresSearchLimits.MAX_WORDS * 2);
  const tokensLength = tokens.join('').length;
  const slugCandidate = term.startsWith('@') ? term.slice(1).trim().toLowerCase() : tokens.join('-');
  return {
    term,
    tokens,
    prefixQuery:
      tokens.length && tokensLength >= PostgresSearchLimits.MIN_PREFIX_LENGTH
        ? tokens.map(token => `${token}:*`).join(' & ')
        : null,
    allowTypos: tokensLength >= PostgresSearchLimits.MIN_TYPO_LENGTH,
    slug: slugCandidate || null,
    identifiers: {
      id: parseIntegerId(term),
      publicId: !/\s/.test(term) && isAnyEntityPublicId(term) ? term : null,
    },
  };
};

/**
 * Decodes a GraphQL hashid (e.g. `abcd1234-efgh5678`) for the given type, if the input is one.
 */
export const parseGraphQLIdentifier = (input: ParsedSearchInput, type: IdentifierType): number | null => {
  if (!/^[a-z0-9]{8}(-[a-z0-9]{1,8})*$/i.test(input.term)) {
    return null;
  }

  try {
    const id = idDecode(input.term, type);
    return Number.isInteger(id) && id > 0 && id <= MAX_INT4 && idEncode(id, type) === input.term ? id : null;
  } catch {
    return null;
  }
};

export const isPublicIdOfEntity = (input: ParsedSearchInput, prefix: EntityShortIdPrefix): boolean =>
  isEntityPublicId(input.identifiers.publicId, prefix);
