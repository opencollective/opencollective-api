import DataLoader from 'dataloader';
import { uniq, zipObject } from 'lodash';

import { ContributorsCacheEntry, getContributorsForCollective } from '../../lib/contributors';

export default {
  forCollectiveId: (): DataLoader<number, ContributorsCacheEntry> =>
    new DataLoader(async collectiveIds => {
      const uniqueIds = uniq(collectiveIds);
      const allContributors = await Promise.all(uniqueIds.map(id => getContributorsForCollective(id)));
      const contributorsByIds = zipObject(uniqueIds, allContributors);
      return collectiveIds.map(id => contributorsByIds[id]);
    }),
};
