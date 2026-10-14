/**
 * Redaction of the access logs sent to Hyperwatch: known sensitive headers, URL values and GraphQL variables are
 * removed or replaced before logging, while keeping what traffic analysis needs (address, user agent, path, method,
 * status, timing, operationName, query, non-personal variables such as slugs, ids and amounts).
 *
 * Intentionally kept: the `oc-secret` header (service verification key) and the raw GraphQL query text, so inline
 * literals written by API clients are still logged.
 */

const REDACTED = '[redacted]';

// Headers removed from the logs (names are compared lowercased)
const SENSITIVE_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'api-key',
  'personal-token',
  'x-two-factor-authentication',
]);

const SENSITIVE_HEADER_PATTERN = /token|secret|password|session|api[-_]?key|auth/i;

// Service verification key, kept on purpose
const ALLOWED_HEADERS = new Set(['oc-secret']);

// Keys whose value is redacted in GraphQL variables and query strings. A key matches when a run of its
// segments (camelCase, snake_case or kebab-case) spells one of these words or their plural, e.g. `legalName`,
// `legal_name`, `payeeLegalName`, `newPassword`, `guestInfo.captcha.token`, `postal_code`, `emails`,
// `addresses`. `name` and `description` are public data and stay in the logs.
const SENSITIVE_KEY_WORDS = new Set([
  'email',
  'legalname',
  'firstname',
  'lastname',
  'phone',
  'address',
  'location',
  'postalcode',
  'zip',
  'city',
  'captcha',
  'password',
  'token',
  'secret',
  'otp',
  'code',
  'taxid',
  'idnumber',
  'iban',
  'accountnumber',
  'accountholdername',
  'routingnumber',
  'bic',
  'swift',
  'cardnumber',
  'cvc',
  'cvv',
  // Bank account details (see `IDENTIFIABLE_DATA_FIELDS` in models/PayoutMethod.ts)
  'abartn',
  'bankcode',
  'billercode',
  'branchcode',
  'bsbcode',
  'customerreferencenumber',
  'iddocumentnumber',
  'iddocumenttype',
  'identificationnumber',
  'ifsccode',
  'institutionnumber',
  'interacaccount',
  'sortcode',
  'transitnumber',
  // Free-form payout instructions of an `OTHER` payout method (`data.content`), often bank details. No GraphQL
  // input has a `content` field, so this only matches JSON payloads.
  'content',
  // Grants access to a draft expense and its attachments
  'draftkey',
  'message',
  'privatemessage',
  'html',
]);

// Matched anywhere in the key, e.g. `twoFactorAuthenticatorCode`, `accessToken`, `clientSecret`, `apiKey`
const SENSITIVE_KEY_PATTERN = /twofactor|token|secret|password|captcha|otp|iban|cvc|cvv|api[-_]?key|session/;

// Query string parameters redacted in URLs only: `key` grants access to a draft expense on its permalink
// (`/:collectiveSlug/expenses/:id?key=`, logged through the referer), while GraphQL variables named `key` are not
// secrets (e.g. `editAccountSetting`)
const SENSITIVE_QUERY_PARAMS = new Set(['key']);

// Routes with credentials or personal data in the path
const SENSITIVE_PATHS: Array<[RegExp, string]> = [
  // /graphql/v1/<apiKey>, /graphql/<apiKey> (see the `/graphql{/:version}{/:apiKey}` route)
  [/^(\/graphql(?:\/v\d)?)\/(?!v\d(?:[/?#]|$))[^/?#]+/, `$1/${REDACTED}`],
  // /services/email/unsubscribe/:email/:slug/:type/:token
  [/^(\/services\/email\/unsubscribe\/)[^/?#]+(\/[^/?#]+\/[^/?#]+\/)[^/?#]+/, `$1${REDACTED}$2${REDACTED}`],
];

// Frontend pages with credentials or personal data in the path. The requests they make carry the page URL in their
// referer, so these apply to absolute URLs only (the API serves other routes under the same paths).
const SENSITIVE_PAGE_PATHS: Array<[RegExp, string]> = [
  // /signin/:token, /reset-password/:token, /confirm/email/:token, /confirm/guest/:token
  [/^(\/(?:signin|reset-password|confirm\/email|confirm\/guest)\/)[^/?#]+/, `$1${REDACTED}`],
  // /email/unsubscribe/:email/:slug/:type/:token
  [/^(\/email\/unsubscribe\/)[^/?#]+(\/[^/?#]+\/[^/?#]+\/)[^/?#]+/, `$1${REDACTED}$2${REDACTED}`],
];

// Scheme and host of an absolute URL, e.g. the referer
const URL_ORIGIN = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i;

export const isSensitiveHeader = (name: string): boolean => {
  const lowerCaseName = name.toLowerCase();
  if (ALLOWED_HEADERS.has(lowerCaseName)) {
    return false;
  }
  return SENSITIVE_HEADERS.has(lowerCaseName) || SENSITIVE_HEADER_PATTERN.test(lowerCaseName);
};

// The longest sensitive words span 3 segments (`customerReferenceNumber`). Bounding the runs keeps the matching
// linear in the key length, whatever the request sends.
const MAX_SEGMENTS_PER_WORD = 4;

// Deeper values are redacted rather than inspected, so crafted inputs cannot overflow the stack
const MAX_VARIABLES_DEPTH = 32;

// Redaction runs synchronously and request bodies can reach 50 MB: past these bounds, values are redacted rather than
// inspected, so a large payload cannot block the event loop. Real variables stay far below them.
const MAX_VARIABLES_VALUES = 10000;
const MAX_VARIABLES_JSON_LENGTH = 1000000;

const isSensitiveWord = (segment: string): boolean => {
  const word = segment.toLowerCase();
  return [word, word.replace(/s$/, ''), word.replace(/es$/, ''), word.replace(/ies$/, 'y')].some(singular =>
    SENSITIVE_KEY_WORDS.has(singular),
  );
};

const isSensitiveKey = (key: string): boolean => {
  if (SENSITIVE_KEY_PATTERN.test(key.toLowerCase())) {
    return true;
  }
  // Every run of consecutive segments, so that compound words match inside longer keys (`contactFirstName`)
  // Brackets too, for query string keys like `filter[email]` or `emails[]`
  const segments = key.split(/[_\-\s.[\]]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    for (let end = start + 1; end <= Math.min(segments.length, start + MAX_SEGMENTS_PER_WORD); end++) {
      if (isSensitiveWord(segments.slice(start, end).join(''))) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Returns a deep copy of the GraphQL variables where the values of sensitive keys are replaced with "[redacted]",
 * recursing into arrays and nested inputs. Values beyond the depth and size bounds are redacted without being
 * inspected. The input is not mutated.
 */
export const redactVariables = <T>(variables: T): T => {
  // Values left to inspect, shared by the whole traversal
  const budget = { values: MAX_VARIABLES_VALUES };
  const redact = (value: unknown, depth: number): unknown => {
    if (value && typeof value === 'object' && (depth >= MAX_VARIABLES_DEPTH || budget.values <= 0)) {
      return REDACTED;
    } else if (Array.isArray(value)) {
      budget.values -= value.length;
      return budget.values < 0 ? REDACTED : value.map(item => redact(item, depth + 1));
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      budget.values -= entries.length;
      if (budget.values < 0) {
        return REDACTED;
      }
      const result = {};
      for (const [key, item] of entries) {
        if (isSensitiveKey(key)) {
          result[key] = item === null || item === undefined ? item : REDACTED;
        } else {
          result[key] = redact(item, depth + 1);
        }
      }
      return result;
    } else {
      return value;
    }
  };
  return redact(variables, 0) as T;
};

const isPlainObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Redacts GraphQL variables serialized as JSON. Anything but an object is rejected by Apollo, but would still be
 * logged as is, so it is replaced with "[redacted]".
 */
const redactVariablesJson = (json: string): string => {
  if (json.length > MAX_VARIABLES_JSON_LENGTH) {
    return REDACTED;
  }
  try {
    const variables = JSON.parse(json);
    return isPlainObject(variables) ? JSON.stringify(redactVariables(variables)) : REDACTED;
  } catch {
    return REDACTED;
  }
};

/**
 * Redacts the `variables` of a GraphQL request body. Clients can also send them as a JSON string.
 */
export const redactRequestVariables = (variables: unknown): unknown => {
  if (variables === null || variables === undefined) {
    return variables;
  } else if (typeof variables === 'string') {
    return redactVariablesJson(variables);
  } else if (isPlainObject(variables)) {
    return redactVariables(variables);
  } else {
    return REDACTED;
  }
};

/**
 * Redacts credentials and personal data from the path (see `SENSITIVE_PATHS`, and `SENSITIVE_PAGE_PATHS` for
 * absolute URLs) and from the query string: the
 * values of sensitive parameters (e.g. `?token=`, `?email=`, `?code=`) are replaced with "[redacted]", and GraphQL
 * variables passed in `?variables=` go through `redactVariables`.
 */
export const redactUrl = (url: string): string => {
  const queryStart = url.indexOf('?');
  const origin = url.match(URL_ORIGIN)?.[0] ?? '';
  let path = queryStart === -1 ? url.slice(origin.length) : url.slice(origin.length, queryStart);
  for (const [pattern, replacement] of origin ? [...SENSITIVE_PATHS, ...SENSITIVE_PAGE_PATHS] : SENSITIVE_PATHS) {
    path = path.replace(pattern, replacement);
  }
  path = `${origin}${path}`;
  if (queryStart === -1) {
    return path;
  }

  const params = new URLSearchParams(url.slice(queryStart + 1));
  let redacted = false;
  for (const key of new Set(params.keys())) {
    if (isSensitiveKey(key) || SENSITIVE_QUERY_PARAMS.has(key)) {
      params.set(key, REDACTED);
      redacted = true;
    } else if (key === 'variables') {
      params.set(key, redactVariablesJson(params.get(key)));
      redacted = true;
    }
  }

  return redacted ? `${path}?${params.toString()}` : `${path}${url.slice(queryStart)}`;
};

/**
 * Returns a copy of the headers without the sensitive ones, and with the referer's query string redacted.
 * `hyperwatch.js` applies the same logic to the Immutable log.
 */
export const redactHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(headers)) {
    if (!isSensitiveHeader(name)) {
      result[name] = name === 'referer' && typeof headers[name] === 'string' ? redactUrl(headers[name]) : headers[name];
    }
  }
  return result;
};
