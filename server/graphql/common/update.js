import { get } from 'lodash';

import { purgeCacheForCollective } from '../../lib/cache';
import models from '../../models';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';

function requireArgs(args, paths) {
  paths.forEach(path => {
    if (!get(args, path)) {
      throw new ValidationFailed(`${path} required`);
    }
  });
}

export async function createUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to create an update');
  }

  let CollectiveId = get(args, 'update.collective.id');
  if (!CollectiveId) {
    CollectiveId = get(args, 'update.account.legacyId');
  }

  requireArgs(args, ['update.title', 'update.html']);
  const collective = await models.Collective.findByPk(CollectiveId);

  if (!collective) {
    throw new Error('This collective does not exist');
  } else if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to create an update");
  }

  const update = await models.Update.create({
    title: args.update.title,
    html: args.update.html,
    CollectiveId,
    isPrivate: args.update.isPrivate,
    TierId: get(args, 'update.tier.id'),
    CreatedByUserId: req.remoteUser.id,
    FromCollectiveId: req.remoteUser.CollectiveId,
    makePublicOn: args.update.makePublicOn,
  });

  purgeCacheForCollective(collective.slug);
  return update;
}

async function fetchUpdate(id) {
  let update;
  if (typeof id == 'string') {
    update = await models.Update.findByPk(idDecode(id, IDENTIFIER_TYPES.UPDATE));
  } else {
    update = await models.Update.findByPk(id);
  }
  if (!update) {
    throw new NotFound(`Update with id ${id} not found`);
  }
  return update;
}

export async function editUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to edit this update');
  }

  requireArgs(args, ['update.id']);
  let update = await fetchUpdate(args.update.id);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to edit this update");
  }

  update = await update.edit(req.remoteUser, args.update);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function publishUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to publish this update');
  }

  let update = await fetchUpdate(args.id);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to publish this update");
  }

  update = await update.publish(req.remoteUser, args.notificationAudience);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function unpublishUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to unpublish this update');
  }

  let update = await fetchUpdate(args.id);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to unpublish this update");
  }

  update = await update.unpublish(req.remoteUser);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function deleteUpdate(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You must be logged in to delete this update');
  }

  let update = await fetchUpdate(args.id);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden("You don't have sufficient permissions to delete this update");
  }

  update = await update.delete(req.remoteUser);
  purgeCacheForCollective(collective.slug);
  return update;
}
