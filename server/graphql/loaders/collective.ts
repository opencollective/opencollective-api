import DataLoader from 'dataloader';
import { first, groupBy } from 'lodash';

import { roles } from '../../constants';
import { types as CollectiveType } from '../../constants/collectives';
import models, { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export default {
  /**
   * Returns the collective (account) for this user ID, including incognito profiles
   */
  byUserId: (): DataLoader<number, typeof models.Collective> => {
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
  /**
   * Receives a list of incognito profiles, return their associated "main" profiles.
   * Be careful: the link between an account and the incognito profile is a private information and this helper
   * does not check permissions
   */
  mainProfileFromIncognito: (): DataLoader<typeof models.Collective, typeof models.Collective> => {
    return new DataLoader(async incognitoProfilesIds => {
      // Get all the admins for the incognito profiles
      const members = await models.Member.findAll({
        where: {
          CollectiveId: incognitoProfilesIds,
          role: roles.ADMIN,
        },
        include: [
          // Get the administrator of the incognito profile
          {
            association: 'memberCollective',
            required: true,
            where: { type: CollectiveType.USER, isIncognito: false },
          },
          // Ensures that the requested profile is an incognito profile
          {
            association: 'collective',
            attributes: [],
            required: true,
            where: { type: CollectiveType.USER, isIncognito: true },
          },
        ],
      });

      const groupedMembers = groupBy(members, 'CollectiveId');
      return incognitoProfilesIds.map(incognitoProfileId => {
        const admin = first(groupedMembers[incognitoProfileId]);
        return admin?.memberCollective || null;
      });
    });
  },
};
