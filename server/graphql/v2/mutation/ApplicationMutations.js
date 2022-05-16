import config from 'config';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import { Forbidden, NotFound, RateLimitExceeded, Unauthorized } from '../../errors';
import { ApplicationCreateInput } from '../input/ApplicationCreateInput';
import { ApplicationReferenceInput, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { ApplicationUpdateInput } from '../input/ApplicationUpdateInput';
import { Application } from '../object/Application';

export const createApplicationMutation = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationCreateInput),
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
      ...pick(args.application, ['name', 'description', 'callbackUrl']),
      CreatedByUserId: req.remoteUser.id,
      CollectiveId: req.remoteUser.CollectiveId,
    });

    return application;
  },
};

export const updateApplicationMutation = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationUpdateInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to delete an application.');
    }

    const application = await fetchApplicationWithReference(args.application);
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (req.remoteUser.CollectiveId !== application.CollectiveId) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    return application.update(pick(args.application, ['name', 'description', 'callbackUrl']));
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

    const application = await fetchApplicationWithReference(args.application);
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (req.remoteUser.CollectiveId !== application.CollectiveId) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    return application.destroy();
  },
};
