import DataLoader from 'dataloader';
import { first, groupBy, uniq } from 'lodash';

import { roles } from '../../constants';
import { CollectiveType } from '../../constants/collectives';
import MemberRoles from '../../constants/roles';
import { Collective, Member, Op, sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export default {
  /**
   * Returns the collective (account) for this user ID, including incognito profiles
   */
  byUserId: (): DataLoader<number, Collective> => {
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
          model: Collective,
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
  mainProfileFromIncognito: (): DataLoader<number, Collective> => {
    return new DataLoader(async incognitoProfilesIds => {
      // Get all the admins for the incognito profiles
      const members = await Member.findAll({
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
  /**
   * To check if remoteUser has access to user's private info (email, legal name, etc). `remoteUser` must either:
   * - be the user himself
   * - be an admin of a collective where user is a member (even as incognito, and regardless of the role)
   * - be an admin of the host of a collective where user is a member (even as incognito, and regardless of the role)
   */
  canSeePrivateInfo: (req): DataLoader<number, boolean> => {
    return new DataLoader(async (collectiveIds: number[]) => {
      const remoteUser = req.remoteUser;
      if (!remoteUser) {
        return collectiveIds.map(() => false);
      }

      let administratedMembers = [];

      // Aggregates all the profiles linked to users
      const uniqueCollectiveIds = uniq(collectiveIds.filter(Boolean));
      const otherAccountsCollectiveIds = uniqueCollectiveIds.filter(
        collectiveId => collectiveId !== remoteUser.CollectiveId,
      );

      // Fetch all the admin memberships of `remoteUser` to collectives or collective's hosts
      // that are linked to users`
      if (otherAccountsCollectiveIds.length) {
        await remoteUser.populateRoles();
        const adminOfCollectiveIds = Object.keys(remoteUser.rolesByCollectiveId).filter(id => remoteUser.isAdmin(id));
        administratedMembers = await Member.findAll({
          attributes: ['MemberCollectiveId'],
          group: ['MemberCollectiveId'],
          raw: true,
          mapToModel: false,
          where: { MemberCollectiveId: otherAccountsCollectiveIds, role: { [Op.ne]: MemberRoles.FOLLOWER } },
          include: {
            association: 'collective',
            required: true,
            attributes: [],
            where: {
              [Op.or]: [
                { id: adminOfCollectiveIds }, // Either `remoteUser` is an admin of the collective
                { ParentCollectiveId: adminOfCollectiveIds }, // Or an admin of the parent collective
                { HostCollectiveId: adminOfCollectiveIds }, // Or `remoteUser` is an admin of the collective's host
              ],
            },
          },
        });
      }

      // User must be self or directly administered by remoteUser
      const administratedMemberCollectiveIds = new Set(administratedMembers.map(m => m.MemberCollectiveId));
      return collectiveIds.map(collectiveId => {
        return (
          collectiveId === remoteUser.CollectiveId ||
          req.remoteUser.isAdmin(collectiveId) ||
          administratedMemberCollectiveIds.has(collectiveId)
        );
      });
    });
  },
};
