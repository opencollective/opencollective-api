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
  const segments = key.split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
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
 * recursing into arrays and nested inputs. The input is not mutated.
 */
export const redactVariables = <T>(variables: T, depth = 0): T => {
  if (variables && typeof variables === 'object' && depth >= MAX_VARIABLES_DEPTH) {
    return REDACTED as T;
  } else if (Array.isArray(variables)) {
    return variables.map(item => redactVariables(item, depth + 1)) as T;
  } else if (variables && typeof variables === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(variables)) {
      if (isSensitiveKey(key)) {
        result[key] = value === null || value === undefined ? value : REDACTED;
      } else {
        result[key] = redactVariables(value, depth + 1);
      }
    }
    return result as T;
  } else {
    return variables;
  }
};

/**
 * Redacts credentials and personal data from the path (see `SENSITIVE_PATHS`) and from the query string: the
 * values of sensitive parameters (e.g. `?token=`, `?email=`, `?code=`) are replaced with "[redacted]", and GraphQL
 * variables passed in `?variables=` go through `redactVariables`.
 */
export const redactUrl = (url: string): string => {
  const queryStart = url.indexOf('?');
  let path = queryStart === -1 ? url : url.slice(0, queryStart);
  for (const [pattern, replacement] of SENSITIVE_PATHS) {
    path = path.replace(pattern, replacement);
  }
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
      try {
        const variables = JSON.parse(params.get(key));
        // Anything but an object is rejected by Apollo, but would still be logged as is
        const isObject = variables !== null && typeof variables === 'object' && !Array.isArray(variables);
        params.set(key, isObject ? JSON.stringify(redactVariables(variables)) : REDACTED);
      } catch {
        params.set(key, REDACTED);
      }
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
