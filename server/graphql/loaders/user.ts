import DataLoader from 'dataloader';
import express from 'express';
import { uniqBy } from 'lodash';

import models, { Op } from '../../models';

import { sortResultsSimple } from './helpers';

/**
 * Build a map like { CollectiveId: IncognitoCollectiveId }
 */
const getIncognitoCollectiveIdsMapping = async users => {
  const incognitoMembers = await models.Member.findAll({
    attributes: ['MemberCollectiveId', 'CollectiveId'],
    group: ['MemberCollectiveId', 'CollectiveId'],
    raw: true,
    mapToModel: false,
    where: {
      MemberCollectiveId: users.map(u => u.CollectiveId),
      role: 'ADMIN',
    },
    include: {
      association: 'collective',
      required: true,
      attributes: [],
      where: { isIncognito: true },
    },
  });

  return incognitoMembers.reduce((result, member) => {
    result[member.MemberCollectiveId] = member.CollectiveId;
    return result;
  }, {});
};

/**
 * To check if remoteUser has access to user's private info. `remoteUser` must either:
 * - be the user himself
 * - be an admin of a collective where user is a member (even as incognito, and regardless of the role)
 * - be an admin of the host of a collective where user is a member (even as incognito, and regardless of the role)
 */
export const generateCanSeeUserPrivateInfoLoader = (req: express.Request): DataLoader<number, boolean> => {
  return new DataLoader(async (users: typeof models.User[]) => {
    const remoteUser = req.remoteUser;
    if (!remoteUser) {
      return users.map(() => false);
    }

    let administratedMembers = [];
    let incognitoProfilesMapping = {};

    // Aggregates all the profiles linked to users (including the incognito ones)
    const uniqueUsers = uniqBy(users.filter(Boolean), 'id');
    const otherUsers = uniqueUsers.filter(user => user.id !== remoteUser.id);
    const otherUserCollectiveIds = otherUsers.map(user => user.CollectiveId);
    incognitoProfilesMapping = await getIncognitoCollectiveIdsMapping(uniqueUsers);

    // Fetch all the admin memberships of `remoteUser` to collectives or collective's hosts
    // that are linked to users`
    const allMemberCollectiveIds = [...otherUserCollectiveIds, ...Object.values(incognitoProfilesMapping)];
    if (allMemberCollectiveIds.length) {
      await remoteUser.populateRoles();
      const adminOfCollectiveIds = Object.keys(remoteUser.rolesByCollectiveId).filter(id => remoteUser.isAdmin(id));
      administratedMembers = await models.Member.findAll({
        attributes: ['MemberCollectiveId'],
        group: ['MemberCollectiveId'],
        raw: true,
        mapToModel: false,
        where: { MemberCollectiveId: allMemberCollectiveIds },
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

    const administratedCollectiveIds = new Set(administratedMembers.map(m => m.MemberCollectiveId));
    return users.map(user => {
      if (!user) {
        return false;
      } else if (user.id === remoteUser.id || administratedCollectiveIds.has(user.CollectiveId)) {
        // User is self or directly administered by remoteUser
        return true;
      } else {
        const incognitoProfileId = incognitoProfilesMapping[user.CollectiveId];
        if (incognitoProfileId) {
          // Is user indirectly administered by remoteUser via its incognito profile?
          return administratedCollectiveIds.has(incognitoProfileId);
        } else {
          return false;
        }
      }
    });
  });
};

export const generateUserByCollectiveIdLoader = (): DataLoader<number, boolean> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const users = await models.User.findAll({ where: { CollectiveId: collectiveIds } });
    return sortResultsSimple(collectiveIds, users, user => user.CollectiveId);
  });
};
