import DataLoader from 'dataloader';
import { uniq, zipObject } from 'lodash';

import { ContributorsCacheEntry, getContributorsForCollective } from '../../lib/contributors';
import Collective from '../../models/Collective';

export default {
  forCollectiveId: (): DataLoader<number, ContributorsCacheEntry> =>
    new DataLoader(async collectiveIds => {
      const uniqueIds = uniq(collectiveIds);
      const collectives = await Collective.findAll({ where: { id: uniqueIds } });
      const sortedCollectives = uniqueIds.map(id => collectives.find(c => c.id === id));
      const allContributors = await Promise.all(
        sortedCollectives.map(collective => getContributorsForCollective(collective)),
      );
      const contributorsByIds = zipObject(uniqueIds, allContributors);
      const result = collectiveIds.map(id => contributorsByIds[id]);
      return result;
    }),
};
