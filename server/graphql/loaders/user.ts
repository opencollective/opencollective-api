import DataLoader from 'dataloader';
import express from 'express';
import { uniq } from 'lodash';

import models, { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

/**
 * To check if remoteUser has access to user's private info (email, legal name, etc). `remoteUser` must either:
 * - be the user himself
 * - be an admin of a collective where user is a member (even as incognito, and regardless of the role)
 * - be an admin of the host of a collective where user is a member (even as incognito, and regardless of the role)
 */
export const generateCanSeeAccountPrivateInfoLoader = (req: express.Request): DataLoader<number, boolean> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const remoteUser = req.remoteUser;
    if (!remoteUser) {
      return collectiveIds.map(() => false);
    }

    // Aggregates all the profiles linked to users
    const uniqueCollectiveIds = uniq(collectiveIds.filter(Boolean));
    const otherAccountsCollectiveIds = uniqueCollectiveIds.filter(
      collectiveId => collectiveId !== remoteUser.CollectiveId,
    );

    // Fetch all the admin memberships of `remoteUser` to collectives or collective's hosts
    // that are linked to users`
    let authorizedCollectiveIds = new Set();
    await remoteUser.populateRoles();
    const adminOfCollectiveIds = req.remoteUser.getAdministratedCollectiveIds();
    if (otherAccountsCollectiveIds.length && adminOfCollectiveIds.length) {
      const result = await sequelize.query(
        `
        SELECT
          ARRAY_AGG(DISTINCT member_collective.id) AS authorized_accounts,
          ARRAY_AGG(DISTINCT member_collective_admins."MemberCollectiveId") AS authorized_admins
        FROM "Members" AS "Member"
        INNER JOIN "Collectives" AS collective
          ON "Member"."CollectiveId" = collective."id"
          AND collective."deletedAt" IS NULL
        INNER JOIN "Collectives" AS member_collective
          ON "Member"."MemberCollectiveId" = member_collective.id
          AND member_collective."deletedAt" IS NULL
        LEFT JOIN "Members" member_collective_admins
          ON member_collective.type != 'USER'
          AND member_collective_admins."CollectiveId" = member_collective.id
          AND member_collective_admins.role = 'ADMIN'
          AND member_collective_admins."deletedAt" IS NULL
        WHERE "Member"."deletedAt" IS NULL
        -- Only requested accounts
        AND (
          member_collective.id IN (:collectiveIds)
          OR member_collective_admins."MemberCollectiveId" IN (:collectiveIds)
        )
        -- Only for administrated accounts
        AND (
          collective."id" IN (:adminOfCollectiveIds)
          OR collective."ParentCollectiveId" IN (:adminOfCollectiveIds)
          OR collective."HostCollectiveId" IN (:adminOfCollectiveIds)
        )
      `,
        {
          raw: true,
          mapToModel: false,
          type: sequelize.QueryTypes.SELECT,
          plain: true,
          replacements: {
            adminOfCollectiveIds,
            collectiveIds: otherAccountsCollectiveIds,
          },
        },
      );

      authorizedCollectiveIds = new Set([
        ...(result['authorized_accounts'] || []),
        ...(result['authorized_admins'] || []),
      ]);
    }

    // User must be self or directly administered by remoteUser
    return collectiveIds.map(collectiveId => {
      return collectiveId === remoteUser.CollectiveId || authorizedCollectiveIds.has(collectiveId);
    });
  });
};

export const generateUserByCollectiveIdLoader = (): DataLoader<number, boolean> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const users = await models.User.findAll({ where: { CollectiveId: collectiveIds } });
    return sortResultsSimple(collectiveIds, users, user => user.CollectiveId);
  });
};
