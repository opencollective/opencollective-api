import DataLoader from 'dataloader';

import models, { sequelize } from '../../models/index.js';
import User from '../../models/User.js';

import { sortResultsSimple } from './helpers.js';

export const generateUserByCollectiveIdLoader = (): DataLoader<number, User> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const users = await models.User.findAll({ where: { CollectiveId: collectiveIds } });
    return sortResultsSimple(collectiveIds, users, user => user.CollectiveId);
  });
};

export const generateUserHasTwoFactorAuthEnabled = (): DataLoader<number, boolean> =>
  new DataLoader(async (userIds: number[]) => {
    const results: { id: number; hasTwoFactorAuthEnabled: boolean }[] = await sequelize.query(
      `
    SELECT u.id "UserId", (count(utfm.id) > 0) "hasTwoFactorAuthEnabled"
    FROM "Users" u
    LEFT JOIN "UserTwoFactorMethods" utfm ON u.id = utfm."UserId" AND utfm."deletedAt" IS NULL
    WHERE u.id IN (:userIds)
    GROUP BY u.id
  `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          userIds,
        },
      },
    );

    return sortResultsSimple(userIds, results, result => result.UserId).map(result => result.hasTwoFactorAuthEnabled);
  });
