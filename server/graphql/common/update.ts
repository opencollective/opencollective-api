import { get } from 'lodash';

import MemberRoles from '../../constants/roles';
import cache, { purgeCacheForCollective } from '../../lib/cache';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import models from '../../models';
import { UPDATE_NOTIFICATION_AUDIENCE } from '../../models/Update';
import { Forbidden, NotFound, ValidationFailed } from '../errors';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';
import { fetchAccountWithReference } from '../v2/input/AccountReferenceInput';

import { checkRemoteUserCanUseUpdates } from './scope-check';

export async function createUpdate(_, args, req) {
  checkRemoteUserCanUseUpdates(req);

  const collective = await fetchAccountWithReference(args.update.account);
  if (!collective) {
    throw new Error('This collective does not exist');
  } else if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isCommunityManager(collective)) {
    throw new Forbidden("You don't have sufficient permissions to create an update");
  } else if (args.update.isChangelog && !collective.data?.canHaveChangelogUpdates) {
    throw new Forbidden('This account cannot have changelog updates');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  const update = await models.Update.create({
    title: args.update.title,
    html: args.update.html,
    CollectiveId: collective.id,
    isPrivate: args.update.isPrivate,
    isChangelog: args.update.isChangelog,
    TierId: get(args, 'update.tier.id'),
    CreatedByUserId: req.remoteUser.id,
    FromCollectiveId: req.remoteUser.CollectiveId,
    makePublicOn: args.update.makePublicOn,
    notificationAudience: args.update.notificationAudience,
  });

  purgeCacheForCollective(collective.slug);
  return update;
}

/**
 * Fetches the update. Throws if the update does not exists or if user is not allowed to edit it.
 */
async function fetchUpdateForEdit(id, req) {
  if (!id) {
    throw new ValidationFailed(`Update ID is required`);
  }

  const update = await models.Update.findByPk(idDecode(id, IDENTIFIER_TYPES.UPDATE), {
    include: { association: 'collective', required: true },
  });
  if (!update) {
    throw new NotFound(`Update with id ${id} not found`);
  } else if (
    !req.remoteUser?.isAdminOfCollective(update.collective) &&
    !req.remoteUser?.isCommunityManager(update.collective)
  ) {
    throw new Forbidden("You don't have sufficient permissions to edit this update");
  }

  await twoFactorAuthLib.enforceForAccount(req, update.collective, { onlyAskOnLogin: true });

  return update;
}

export async function editUpdate(_, args, req) {
  checkRemoteUserCanUseUpdates(req);

  let update = await fetchUpdateForEdit(args.update.id, req);
  update = await update.edit(req.remoteUser, args.update);
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function publishUpdate(_, args, req) {
  checkRemoteUserCanUseUpdates(req);

  let update = await fetchUpdateForEdit(args.id, req);
  update = await update.publish(req.remoteUser, args.notificationAudience || update.notificationAudience);
  if (update.isChangelog) {
    cache.delete('latest_changelog_publish_date');
  }
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function unpublishUpdate(_, args, req) {
  checkRemoteUserCanUseUpdates(req);

  let update = await fetchUpdateForEdit(args.id, req);
  update = await update.unpublish(req.remoteUser);
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function deleteUpdate(_, args, req) {
  checkRemoteUserCanUseUpdates(req);

  let update = await fetchUpdateForEdit(args.id, req);
  update = await update.delete(req.remoteUser);
  purgeCacheForCollective(update.collective.slug);
  return update;
}

const canSeeUpdateForFinancialContributors = (req, collective): Promise<boolean> => {
  const allowedNonAdminRoles = [
    MemberRoles.MEMBER,
    MemberRoles.COMMUNITY_MANAGER,
    MemberRoles.CONTRIBUTOR,
    MemberRoles.BACKER,
  ];
  return (
    req.remoteUser.isAdminOfCollectiveOrHost(collective) ||
    req.remoteUser.hasRole(allowedNonAdminRoles, collective.id) ||
    req.remoteUser.hasRole(allowedNonAdminRoles, collective.ParentCollectiveId) ||
    req.loaders.Member.remoteUserIsIndirectFinancialContributor.load(collective.id)
  );
};

const canSeeUpdateForCollectiveAdmins = async (req, collective): Promise<boolean> => {
  if (!collective.hasMoneyManagement) {
    return req.remoteUser.isAdminOfCollectiveOrHost(collective);
  }

  return (
    req.remoteUser.isAdminOfCollectiveOrHost(collective) ||
    (await req.loaders.Member.remoteUserIdAdminOfHostedAccount.load(collective.id))
  );
};

export async function canSeeUpdate(req, update): Promise<boolean> {
  if (update.publishedAt && !update.isPrivate) {
    return true; // If the update is published and not private, it's visible to everyone
  } else if (!req.remoteUser) {
    return false; // If the update is not published or private, it's not visible to logged out users
  }

  // Load collective
  update.collective = update.collective || (await req.loaders.Collective.byId.load(update.CollectiveId));
  if (!update.collective) {
    return false;
  }

  // Admins & community managers can always see updates
  if (req.remoteUser.isAdminOfCollective(update.collective) || req.remoteUser.isCommunityManager(update.collective)) {
    return true;
  } else if (!update.publishedAt) {
    return false; // Only admins can see drafts
  } else if (req.remoteUser.isAdmin(update.collective.HostCollectiveId)) {
    return true; // Host admins can always see their collective's published updates
  }

  // If it's a private published update, we need to look at the audience
  const audience = update.notificationAudience || UPDATE_NOTIFICATION_AUDIENCE.FINANCIAL_CONTRIBUTORS;
  switch (audience) {
    case UPDATE_NOTIFICATION_AUDIENCE.FINANCIAL_CONTRIBUTORS:
      return canSeeUpdateForFinancialContributors(req, update.collective);
    case UPDATE_NOTIFICATION_AUDIENCE.COLLECTIVE_ADMINS:
      return canSeeUpdateForCollectiveAdmins(req, update.collective);
    case UPDATE_NOTIFICATION_AUDIENCE.ALL:
      return (
        (await canSeeUpdateForFinancialContributors(req, update.collective)) ||
        (await canSeeUpdateForCollectiveAdmins(req, update.collective))
      );
    case UPDATE_NOTIFICATION_AUDIENCE.NO_ONE:
      return req.remoteUser.isAdminOfCollective(update.collective);
    default:
      return false; // Audience type is NO_ONE or unknown
  }
}
