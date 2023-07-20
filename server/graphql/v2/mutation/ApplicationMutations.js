import config from 'config';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash-es';

import twoFactorAuthLib from '../../../lib/two-factor-authentication/index.js';
import models from '../../../models/index.js';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check.js';
import { Forbidden, NotFound, RateLimitExceeded } from '../../errors.js';
import { fetchAccountWithReference } from '../input/AccountReferenceInput.js';
import { GraphQLApplicationCreateInput } from '../input/ApplicationCreateInput.js';
import { fetchApplicationWithReference, GraphQLApplicationReferenceInput } from '../input/ApplicationReferenceInput.js';
import { GraphQLApplicationUpdateInput } from '../input/ApplicationUpdateInput.js';
import { GraphQLApplication } from '../object/Application.js';

const createApplication = {
  type: GraphQLApplication,
  args: {
    application: {
      type: new GraphQLNonNull(GraphQLApplicationCreateInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseApplications(req);

    const collective = args.application.account
      ? await fetchAccountWithReference(args.application.account, { throwIfMissing: true })
      : req.remoteUser.collective;

    // Enforce 2FA
    await twoFactorAuthLib.enforceForAccount(req, collective);

    if (!req.remoteUser.isAdminOfCollective(collective)) {
      throw new Forbidden();
    }

    const numberOfAppsForThisAccount = await models.Application.count({ where: { CollectiveId: collective.id } });
    if (numberOfAppsForThisAccount >= config.limits.maxNumberOfAppsPerUser) {
      throw new RateLimitExceeded('You have reached the maximum number of applications for this user');
    }

    const createParams = {
      ...pick(args.application, ['type', 'name', 'description']),
      callbackUrl: args.application.redirectUri,
      CreatedByUserId: req.remoteUser.id,
      CollectiveId: collective.id,
    };

    return models.Application.create(createParams);
  },
};

const updateApplication = {
  type: GraphQLApplication,
  args: {
    application: {
      type: new GraphQLNonNull(GraphQLApplicationUpdateInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseApplications(req);

    const application = await fetchApplicationWithReference(args.application, {
      include: [{ association: 'collective', required: true }],
    });
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (!req.remoteUser.isAdminOfCollective(application.collective)) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    const updateParams = pick(args.application, ['name', 'description']);

    // Doing this we're not supporting update to NULL
    if (args.application.redirectUri) {
      updateParams.callbackUrl = args.application.redirectUri;
    }

    return application.update(updateParams);
  },
};

const deleteApplication = {
  type: GraphQLApplication,
  args: {
    application: {
      type: new GraphQLNonNull(GraphQLApplicationReferenceInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseApplications(req);

    const application = await fetchApplicationWithReference(args.application, {
      include: [{ association: 'collective', required: true }],
    });
    if (!application) {
      throw new NotFound(`Application not found`);
    } else if (!req.remoteUser.isAdminOfCollective(application.collective)) {
      throw new Forbidden('Authenticated user is not the application owner.');
    }

    return application.destroy();
  },
};

const applicationMutations = {
  createApplication,
  updateApplication,
  deleteApplication,
};

export default applicationMutations;
