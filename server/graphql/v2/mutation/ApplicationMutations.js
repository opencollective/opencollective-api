import config from 'config';
import { GraphQLNonNull } from 'graphql';

import { Forbidden, NotFound, RateLimitExceeded, Unauthorized } from '../../errors';
import { ApplicationInput } from '../input/ApplicationInput';
import { ApplicationReferenceInput, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { Application } from '../object/Application';

export const createApplicationMutation = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to create an application.');
    }

    const numberOfAppsForThisUser = await Application.count({
      where: {
        CollectiveId: req.remoteUser.CollectiveId,
      },
    });

    if (numberOfAppsForThisUser >= config.limits.maxNumberOfAppsPerUser) {
      throw new RateLimitExceeded('You have reached the maximum number of applications for this user');
    }

    const application = await Application.create({
      ...args.application,
      CreatedByUserId: req.remoteUser.id,
      CollectiveId: req.remoteUser.CollectiveId,
    });

    return application;
  },
};

export const deleteApplicationMutation = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationReferenceInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to delete an application.');
    }

    const app = await fetchApplicationWithReference(args.application);
    if (!app) {
      throw new NotFound(`Application with id ${args.id} not found`);
    } else if (req.remoteUser.CollectiveId !== app.CollectiveId) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    return app.destroy();
  },
};
