import { get } from 'lodash';

import cache, { purgeCacheForCollective } from '../../lib/cache';
import models from '../../models';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';
import { fetchAccountWithReference } from '../v2/input/AccountReferenceInput';

export async function createUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to create an update');
  }

  const collective = await fetchAccountWithReference(args.update.account);
  if (!collective) {
    throw new Error('This collective does not exist');
  } else if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to create an update");
  } else if (args.update.isChangelog && !req.remoteUser.isRoot()) {
    throw new Forbidden('Only root users can create changelog updates.');
  }

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
  });

  purgeCacheForCollective(collective.slug);
  return update;
}

/**
 * Fetches the update. Throws if the update does not exists or if user is not allowed to edit it.
 */
async function fetchUpdateForEdit(id, remoteUser) {
  if (!remoteUser) {
    throw new Unauthorized('You must be logged in to edit this update');
  } else if (!id) {
    throw new ValidationFailed(`Update ID is required`);
  }

  const update = await models.Update.findByPk(idDecode(id, IDENTIFIER_TYPES.UPDATE), {
    include: { association: 'collective' },
  });
  if (!update) {
    throw new NotFound(`Update with id ${id} not found`);
  } else if (!remoteUser.isAdminOfCollective(update.collective)) {
    throw new Forbidden("You don't have sufficient permissions to edit this update");
  }

  return update;
}

export async function editUpdate(_, args, req) {
  let update = await fetchUpdateForEdit(args.update.id, req.remoteUser);
  update = await update.edit(req.remoteUser, args.update);
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function publishUpdate(_, args, req) {
  let update = await fetchUpdateForEdit(args.id, req.remoteUser);
  update = await update.publish(req.remoteUser, args.notificationAudience);
  if (update.isChangelog) {
    cache.del('latest_changelog_publish_date');
  }
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function unpublishUpdate(_, args, req) {
  let update = await fetchUpdateForEdit(args.id, req.remoteUser);
  update = await update.unpublish(req.remoteUser);
  purgeCacheForCollective(update.collective.slug);
  return update;
}

export async function deleteUpdate(_, args, req) {
  let update = await fetchUpdateForEdit(args.id, req.remoteUser);
  update = await update.delete(req.remoteUser);
  purgeCacheForCollective(update.collective.slug);
  return update;
}
