import DataLoader from 'dataloader';

import models, { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export default {
  /**
   * Returns the collective (account) for this user ID, including incognito profiles
   */
  byUserId: (): DataLoader<number, object> => {
    return new DataLoader(async userIds => {
      const collectives = await sequelize.query(
        ` SELECT      c.*, u.id AS __user_id__
          FROM        "Collectives" c
          INNER JOIN  "Users" u ON u."CollectiveId" = c.id
          WHERE       u.id in (:userIds)
          AND         c."deletedAt" IS NULL
          GROUP BY    u."id", c.id`,
        {
          type: sequelize.QueryTypes.SELECT,
          model: models.Collective,
          mapToModel: true,
          replacements: { userIds },
        },
      );

      return sortResultsSimple(userIds, collectives, result => result.dataValues['__user_id__']);
    });
  },
};
