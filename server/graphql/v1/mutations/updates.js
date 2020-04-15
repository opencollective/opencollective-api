import { get } from 'lodash';

import { mustHaveRole } from '../../../lib/auth';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import { stripTags } from '../../../lib/utils';
import models from '../../../models';
import { NotFound, ValidationFailed } from '../../errors';

function require(args, path) {
  if (!get(args, path)) {
    throw new ValidationFailed(`${path} required`);
  }
}

export async function createUpdate(_, args, req) {
  const CollectiveId = get(args, 'update.collective.id');
  mustHaveRole(req.remoteUser, 'ADMIN', CollectiveId, 'create an update');
  require(args, 'update.title');

  const collective = await models.Collective.findByPk(CollectiveId);

  if (!collective) {
    throw new Error('This collective does not exist');
  }

  const markdown = args.update.markdown ? stripTags(args.update.markdown) : '';

  const update = await models.Update.create({
    title: args.update.title,
    markdown,
    html: stripTags(args.update.html),
    CollectiveId,
    isPrivate: args.update.isPrivate,
    TierId: get(args, 'update.tier.id'),
    CreatedByUserId: req.remoteUser.id,
    FromCollectiveId: req.remoteUser.CollectiveId,
    makePublicOn: args.update.makePublicOn,
  });

  purgeCacheForPage(`/${collective.slug}`);
  return update;
}

async function fetchUpdate(id) {
  const update = await models.Update.findByPk(id);
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
  purgeCacheForPage(`/${collective.slug}`);
  return update;
}

export async function publishUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.publish(req.remoteUser);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForPage(`/${collective.slug}`);
  return update;
}

export async function unpublishUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.unpublish(req.remoteUser);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForPage(`/${collective.slug}`);
  return update;
}

export async function deleteUpdate(_, args, req) {
  let update = await fetchUpdate(args.id);
  update = await update.delete(req.remoteUser);
  const collective = await models.Collective.findByPk(update.CollectiveId);
  purgeCacheForPage(`/${collective.slug}`);
  return update;
}
