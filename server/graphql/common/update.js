import { get } from 'lodash';

import { mustHaveRole } from '../../lib/auth';
import { purgeCacheForCollective } from '../../lib/cache';
import models from '../../models';
import { NotFound, ValidationFailed } from '../errors';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';

function require(args, path) {
  if (!get(args, path)) {
    throw new ValidationFailed(`${path} required`);
  }
}

export async function createUpdate(_, args, req) {
  let CollectiveId = get(args, 'update.collective.id');
  if (!CollectiveId) {
    CollectiveId = get(args, 'update.account.legacyId');
  }
  mustHaveRole(req.remoteUser, 'ADMIN', CollectiveId, 'create an update');
  require(args, 'update.title');

  const collective = await models.Collective.findByPk(CollectiveId);

  if (!collective) {
    throw new Error('This collective does not exist');
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
  require(args, 'update.id');
  let update = await fetchUpdate(args.update.id);
  update = await update.edit(req.remoteUser, args.update);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function publishUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.publish(req.remoteUser, args.notificationAudience);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function unpublishUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.unpublish(req.remoteUser);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForCollective(collective.slug);
  return update;
}

export async function deleteUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.delete(req.remoteUser);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForCollective(collective.slug);
  return update;
}
