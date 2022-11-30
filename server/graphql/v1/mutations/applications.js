import config from 'config';
import { get } from 'lodash';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { Forbidden, NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';

const { Application } = models;

function requireArgs(args, path) {
  if (!get(args, path)) {
    throw new ValidationFailed(`${path} required`);
  }
}

export async function createApplication(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be authenticated to create an application.');
  }

  requireArgs(args, 'application.type');

  if (args.application.type === 'oauth') {
    requireArgs(args, 'application.name');
  }

  const numberOfAppsForThisUser = await Application.count({
    where: {
      CollectiveId: req.remoteUser.CollectiveId,
    },
  });

  if (numberOfAppsForThisUser >= config.limits.maxNumberOfAppsPerUser) {
    throw new RateLimitExceeded('You have reached the maximum number of applications for this user');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, req.remoteUser.collective);

  const app = await Application.create({
    ...args.application,
    CreatedByUserId: req.remoteUser.id,
    CollectiveId: req.remoteUser.CollectiveId,
  });

  return app;
}

export async function deleteApplication(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be authenticated to delete an application.');
  }

  const app = await Application.findByPk(args.id, { include: [{ association: 'collective', required: true }] });
  if (!app) {
    throw new NotFound(`Application with id ${args.id} not found`);
  } else if (req.remoteUser.CollectiveId !== app.CollectiveId) {
    throw new Forbidden('Authenticated user is not the application owner.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, app.collective, { onlyAskOnLogin: true });

  return await app.destroy();
}
