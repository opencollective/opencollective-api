import config from 'config';

import { types as CollectiveType } from '../constants/collectives';

export const getEditRecurringContributionsUrl = collective => {
  if (collective.type === CollectiveType.USER) {
    return `${config.host.website}/recurring-contributions`;
  } else {
    return `${config.host.website}/${collective.slug}/recurring-contributions`;
  }
};
