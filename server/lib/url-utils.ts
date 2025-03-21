import config from 'config';
import isURL from 'validator/lib/isURL';

export const getEditRecurringContributionsUrl = collective => {
  return `${config.host.website}/dashboard/${collective.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`;
};

export const getHostname = url => {
  return new URL(url).hostname.replace(/^www\./, '');
};

/**
 * Takes an URL like https://xxx.opencollective.com/test, returns 'opencollective.com'
 */
export const getRootDomain = (url: string): string => {
  return getHostname(url).split('.').slice(-2).join('.');
};

export const isValidRESTServiceURL = (url: string): boolean => {
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch {
    return false;
  }

  return parsedURL.origin === config.host.rest;
};

export function isValidURL(url: string) {
  const isDevEnv =
    ['development', 'test', 'e2e', 'ci'].includes(config.env) ||
    process.env.E2E_TEST ||
    process.env.NODE_ENV !== 'production';
  return isURL(url, {
    // eslint-disable-next-line camelcase
    require_host: !isDevEnv,
    // eslint-disable-next-line camelcase
    require_tld: !isDevEnv,
  });
}
