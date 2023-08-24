import config from 'config';

import { CollectiveType } from '../constants/collectives';

export const getEditRecurringContributionsUrl = collective => {
  if (collective.type === CollectiveType.USER) {
    return `${config.host.website}/manage-contributions`;
  } else {
    return `${config.host.website}/${collective.slug}/manage-contributions`;
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
