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
 * Loopback hosts for which `http:` redirect URIs are accepted.
 * See RFC 8252 section 7.3 and RFC 9700 section 2.1: traffic to these hosts never leaves the device.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate an OAuth application redirect URI at registration time.
 * Only `https:` is allowed, except for loopback hosts (local development).
 */
export function assertOAuthRedirectUri(redirectUri: string): string {
  const parsed = parseNavigableHttpUrl(redirectUri);
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new ValidationFailed(`URL must use HTTPS: ${redirectUri}`);
  }

  return parsed.toString();
}
