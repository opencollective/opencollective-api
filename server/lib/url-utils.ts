import config from 'config';

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
