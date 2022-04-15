import config from 'config';

import { types as CollectiveType } from '../constants/collectives';

export const getEditRecurringContributionsUrl = collective => {
  if (collective.type === CollectiveType.USER) {
    return `${config.host.website}/recurring-contributions`;
  } else {
    return `${config.host.website}/${collective.slug}/recurring-contributions`;
  }
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
