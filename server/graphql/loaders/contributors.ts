import DataLoader from 'dataloader';
import { uniq, zipObject } from 'lodash';

import { ContributorsCacheEntry, getContributorsForCollective } from '../../lib/contributors';
import models from '../../models';

export default {
  forCollectiveId: (): DataLoader<number, ContributorsCacheEntry> =>
    new DataLoader(async collectiveIds => {
      const uniqueIds = uniq(collectiveIds);
      const collectives = await models.Collective.findAll({ where: { id: uniqueIds } });
      const allContributors = await Promise.all(
        collectives.map(collective => getContributorsForCollective(collective)),
      );
      const contributorsByIds = zipObject(uniqueIds, allContributors);
      return collectiveIds.map(id => contributorsByIds[id]);
    }),
};
