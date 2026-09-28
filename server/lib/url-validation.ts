import config from 'config';

import { ValidationFailed } from '../graphql/errors';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

type ParseHttpUrlOptions = {
  /**
   * When false, only `https:` is accepted. Defaults to true so GraphQL `URL` fields
   * and local/dev OAuth clients can use `http://localhost`.
   */
  allowHttp?: boolean;
};

/**
 * HTTP redirect URIs are allowed outside production so local OAuth clients can use
 * `http://localhost`. Mirrors the non-production URL checks in `url-utils.ts`.
 */
export const areHttpRedirectUrisAllowed = (): boolean => config.env !== 'production';

/**
 * Parse `value` as a navigable HTTP(S) URL.
 * Rejects `javascript:`, `data:`, `blob:`, and other non-http(s) schemes.
 */
export function parseNavigableHttpUrl(value: unknown, options: ParseHttpUrlOptions = {}): URL {
  const { allowHttp = true } = options;

  if (typeof value !== 'string') {
    throw new ValidationFailed(`Not a valid URL: ${value}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationFailed(`Not a valid URL: ${value}`);
  }

  const allowedProtocols = allowHttp ? HTTP_PROTOCOLS : new Set(['https:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    const expected = allowHttp ? 'HTTP or HTTPS' : 'HTTPS';
    throw new ValidationFailed(`URL must use ${expected}: ${value}`);
  }

  if (!parsed.hostname) {
    throw new ValidationFailed(`URL must include a hostname: ${value}`);
  }

  return parsed;
}

/**
 * Validate an OAuth application redirect URI at registration time.
 * Production allows only `https:`; other environments also allow `http:` for local dev.
 */
export function assertOAuthRedirectUri(redirectUri: string): string {
  return parseNavigableHttpUrl(redirectUri, { allowHttp: areHttpRedirectUrisAllowed() }).toString();
}
