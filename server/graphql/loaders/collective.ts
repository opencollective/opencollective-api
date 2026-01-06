import DataLoader from 'dataloader';
import { first, groupBy, uniq, uniqBy } from 'lodash';

import { roles } from '../../constants';
import { CollectiveType } from '../../constants/collectives';
import MemberRoles from '../../constants/roles';
import models, { Collective, Op, sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

type CommunityActivitySummaryRow = {
  HostCollectiveId: number;
  CollectiveId: number;
  FromCollectiveId: number;
  activities: string[];
  relations: string[];
  lastInteractionAt: Date;
  firstInteractionAt: Date;
};

export default {
  /**
   * Returns the collective (account) for this user ID, including incognito profiles
   */
  byUserId: (): DataLoader<number, Collective> => {
    return new DataLoader(async userIds => {
      const collectives: Array<Collective> = await sequelize.query(
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
  mainProfileFromIncognito: (): DataLoader<number, Collective> => {
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
  /**
   * To check if remoteUser has access to user's private info (email, legal name, etc). `remoteUser` must either:
   * - be the user himself
   * - be an admin of a collective where user is a member (even as incognito, and regardless of the role)
   * - be an admin of the host of a collective where user is a member (even as incognito, and regardless of the role)
   */
  canSeePrivateProfileInfo: (req): DataLoader<number, boolean> => {
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
        const adminOfCollectiveIds = remoteUser.getAdministratedCollectiveIds();
        administratedMembers = await models.Member.findAll({
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
  /**
   * To check if remoteUser has access to user's private location. `remoteUser` must either:
   * - be the user himself
   * - be an admin of the host of a collective where user is a member (even as incognito, and regardless of the role)
   */
  canSeePrivateLocation: (req): DataLoader<number, boolean> => {
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
        const adminOfCollectiveIds = remoteUser.getAdministratedCollectiveIds();
        administratedMembers = await models.Member.findAll({
          attributes: ['MemberCollectiveId'],
          group: ['MemberCollectiveId'],
          raw: true,
          mapToModel: false,
          where: { MemberCollectiveId: otherAccountsCollectiveIds, role: { [Op.ne]: MemberRoles.FOLLOWER } },
          include: {
            association: 'collective',
            required: true,
            attributes: [],
            where: { HostCollectiveId: adminOfCollectiveIds }, // `remoteUser` is an admin of the collective's host
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
  communityStats: {
    onHostContext: (): DataLoader<{ HostCollectiveId: number; FromCollectiveId: number }, Collective> =>
      new DataLoader(
        async HostCollectivePairs => {
          const conditionals: Record<number, Set<number>> = {};
          const keys = HostCollectivePairs.map(pair => `${pair.HostCollectiveId}-${pair.FromCollectiveId}`);
          HostCollectivePairs.forEach(({ FromCollectiveId, HostCollectiveId }) => {
            conditionals[HostCollectiveId] = conditionals[HostCollectiveId] || new Set();
            conditionals[HostCollectiveId].add(FromCollectiveId);
          });

          const conditionalQuery = Object.entries(conditionals)
            .map(([HostCollectiveId, FromCollectiveIds]) => {
              return `(cas."HostCollectiveId" = ${HostCollectiveId} AND cas."FromCollectiveId" IN (${Array.from(
                FromCollectiveIds,
              ).join(',')}))`;
            })
            .join(' OR ');

          const results: Collective[] = await sequelize.query(
            `
            SELECT
              fc.*,
              JSONB_OBJECT_AGG(cas."CollectiveId", cas."relations") FILTER (WHERE c."type" IN ('COLLECTIVE', 'FUND', 'PROJECT', 'EVENT')) AS "associatedCollectives",
              JSONB_OBJECT_AGG(cas."CollectiveId", cas."relations") FILTER (WHERE c."type" = 'ORGANIZATION') AS "associatedOrganizations",
              cas."HostCollectiveId" AS "contextualHostCollectiveId", MAX(cas."lastInteractionAt") as "lastInteractionAt", MIN(cas."firstInteractionAt") as "firstInteractionAt"
            FROM
              "CommunityActivitySummary" cas
              INNER JOIN "Collectives" fc ON fc.id = cas."FromCollectiveId"
              LEFT JOIN "Collectives" c ON c.id = cas."CollectiveId"
            WHERE
              fc."deletedAt" IS NULL
              AND c."deletedAt" IS NULL
              AND (${conditionalQuery})
            GROUP BY fc.id, cas."HostCollectiveId"`,
            {
              model: Collective,
              mapToModel: true,
            },
          );

          return sortResultsSimple(
            keys,
            results,
            result => `${result.dataValues['contextualHostCollectiveId']}-${result.id}`,
          );
        },
        { cacheKeyFn: arg => `${arg.HostCollectiveId}-${arg.FromCollectiveId}` },
      ),
    forSpecificHostedCollective: (): DataLoader<
      { CollectiveId: number; HostCollectiveId: number; FromCollectiveId: number },
      CommunityActivitySummaryRow
    > => {
      const makeKey = pair => `${pair.HostCollectiveId}-${pair.CollectiveId}-${pair.FromCollectiveId}`;
      return new DataLoader(
        async hostedCollectivePairs => {
          const keys = hostedCollectivePairs.map(makeKey);

          const uniqCombinations = uniqBy(hostedCollectivePairs, makeKey);
          const conditionals = uniqCombinations
            .map(
              ({ HostCollectiveId, CollectiveId, FromCollectiveId }) =>
                `("HostCollectiveId" = ${HostCollectiveId} AND "CollectiveId" = ${CollectiveId} AND "FromCollectiveId" = ${FromCollectiveId})`,
            )
            .join(' OR ');

          const results: CommunityActivitySummaryRow[] = await sequelize.query(
            `
            SELECT
              *
            FROM
              "CommunityActivitySummary"
            WHERE
              (${conditionals})
            `,
            {
              raw: true,
              type: sequelize.QueryTypes.SELECT,
            },
          );

          return sortResultsSimple(keys, results, makeKey);
        },
        { cacheKeyFn: makeKey },
      );
    },
  },
};
