import DataLoader from 'dataloader';

import models, { Collective, sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export default {
  /**
   * Returns the location for this collective ID
   */
  byCollectiveId: (): DataLoader<number, Collective> => {
    return new DataLoader(async collectiveIds => {
      const locations = await sequelize.query(
        ` SELECT      l.*
          FROM        "Locations" l
          WHERE       l."CollectiveId" in (:collectiveIds)
          AND         l."deletedAt" IS NULL`,
        {
          type: sequelize.QueryTypes.SELECT,
          model: models.Location,
          mapToModel: true,
          replacements: { collectiveIds },
        },
      );

      return sortResultsSimple(collectiveIds, locations, result => result.dataValues['CollectiveId']);
    });
  },
};
