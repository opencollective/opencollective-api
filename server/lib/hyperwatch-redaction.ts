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

// Keys whose value is redacted in GraphQL variables and query strings. A key matches when one of its
// segments (camelCase, snake_case or kebab-case) equals one of these words or their plural, e.g. `legalName`,
// `newPassword`, `guestInfo.captcha.token`, `postal_code`, `emails`. `name` and `description` are public data
// and stay in the logs.
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
  'message',
  'privatemessage',
  'html',
]);

// Matched anywhere in the key, e.g. `twoFactorAuthenticatorCode`, `accessToken`, `clientSecret`, `apiKey`
const SENSITIVE_KEY_PATTERN = /twofactor|token|secret|password|captcha|otp|iban|cvc|api_?key|session/;

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

const isSensitiveWord = (segment: string): boolean => {
  const word = segment.toLowerCase();
  return SENSITIVE_KEY_WORDS.has(word) || (word.endsWith('s') && SENSITIVE_KEY_WORDS.has(word.slice(0, -1)));
};

const isSensitiveKey = (key: string): boolean => {
  if (isSensitiveWord(key) || SENSITIVE_KEY_PATTERN.test(key.toLowerCase())) {
    return true;
  }
  const segments = key.split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/);
  return segments.some(isSensitiveWord);
};

/**
 * Returns a deep copy of the GraphQL variables where the values of sensitive keys are replaced with "[redacted]",
 * recursing into arrays and nested inputs. The input is not mutated.
 */
export const redactVariables = <T>(variables: T): T => {
  if (Array.isArray(variables)) {
    return variables.map(item => redactVariables(item)) as T;
  } else if (variables && typeof variables === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(variables)) {
      if (isSensitiveKey(key)) {
        result[key] = value === null || value === undefined ? value : REDACTED;
      } else {
        result[key] = redactVariables(value);
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
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED);
      redacted = true;
    } else if (key === 'variables') {
      try {
        params.set(key, JSON.stringify(redactVariables(JSON.parse(params.get(key)))));
        redacted = true;
      } catch {
        // Not JSON, Apollo will reject it anyway
      }
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
