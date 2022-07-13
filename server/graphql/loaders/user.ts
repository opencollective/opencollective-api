import DataLoader from 'dataloader';
import express from 'express';
import { uniq } from 'lodash';

import models, { Op } from '../../models';

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
      administratedMembers = await models.Member.findAll({
        attributes: ['MemberCollectiveId'],
        group: ['MemberCollectiveId'],
        raw: true,
        mapToModel: false,
        where: { MemberCollectiveId: otherAccountsCollectiveIds },
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
    const administratedCollectiveIds = new Set(administratedMembers.map(m => m.MemberCollectiveId));
    return collectiveIds.map(collectiveId => {
      return collectiveId === remoteUser.CollectiveId || administratedCollectiveIds.has(collectiveId);
    });
  });
};

export const generateUserByCollectiveIdLoader = (): DataLoader<number, boolean> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const users = await models.User.findAll({ where: { CollectiveId: collectiveIds } });
    return sortResultsSimple(collectiveIds, users, user => user.CollectiveId);
  });
};
