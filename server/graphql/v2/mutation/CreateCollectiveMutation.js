import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { get, pick } from 'lodash';

import activities from '../../../constants/activities';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import * as github from '../../../lib/github';
import { defaultHostCollective } from '../../../lib/utils';
import models, { sequelize } from '../../../models';
import { Unauthorized, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CollectiveCreateInput } from '../input/CollectiveCreateInput';
import { IndividualCreateInput } from '../input/IndividualCreateInput';
import { Collective } from '../object/Collective';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

async function createCollective(_, args, req) {
  let shouldAutomaticallyApprove = false;

  const { remoteUser, loaders } = req;

  let user = remoteUser,
    host;

  if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders });
  }

  return sequelize
    .transaction(async transaction => {
      if (!user && args.user && host?.id === defaultHostCollective('foundation').CollectiveId) {
        user = await models.User.findByEmail(args.user.email, transaction);
        if (!user) {
          user = await models.User.createUserWithCollective(args.user, transaction);
        } else {
          throw new Unauthorized('Email already exist, you have to be logged in to apply with this email');
        }
      } else if (!user) {
        throw new Unauthorized('You need to be logged in to create a collective');
      }

      const collectiveData = {
        slug: args.collective.slug.toLowerCase(),
        ...pick(args.collective, ['name', 'description', 'tags']),
        isActive: false,
        CreatedByUserId: user.id,
        settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
      };

      if (isCollectiveSlugReserved(collectiveData.slug)) {
        throw new Error(`The slug '${collectiveData.slug}' is not allowed.`);
      }
      const collectiveWithSlug = await models.Collective.findOne(
        { where: { slug: collectiveData.slug } },
        { transaction },
      );

      if (collectiveWithSlug) {
        throw new Error(
          `The slug ${collectiveData.slug} is already taken. Please use another slug for your collective.`,
        );
      }

      // Handle GitHub automated approval and apply to the Open Source Collective Host
      if (args.automateApprovalWithGithub && args.collective.githubHandle) {
        const githubHandle = args.collective.githubHandle;
        const opensourceHost = defaultHostCollective('opensource');
        host = await loaders.Collective.byId.load(opensourceHost.CollectiveId);
        try {
          const githubAccount = await models.ConnectedAccount.findOne(
            {
              where: { CollectiveId: user.CollectiveId, service: 'github' },
            },
            { transaction },
          );
          if (!githubAccount) {
            throw new Error('You must have a connected GitHub Account to create a collective with GitHub.');
          }
          // In e2e/CI environment, checkGithubAdmin and checkGithubStars will be stubbed
          await github.checkGithubAdmin(githubHandle, githubAccount.token);
          await github.checkGithubStars(githubHandle, githubAccount.token);
          shouldAutomaticallyApprove = true;
        } catch (error) {
          throw new ValidationFailed(error.message);
        }
        if (githubHandle.includes('/')) {
          collectiveData.settings.githubRepo = githubHandle;
        } else {
          collectiveData.settings.githubOrg = githubHandle;
        }
        collectiveData.tags = collectiveData.tags || [];
        if (!collectiveData.tags.includes('open source')) {
          collectiveData.tags.push('open source');
        }
      } else if (args.host) {
        if (!host) {
          throw new ValidationFailed('Host Not Found');
        }
        if (!host.isHostAccount) {
          throw new ValidationFailed('Host account is not activated as Host.');
        }
      }
      const collective = await models.Collective.create(collectiveData, { transaction });
      // Add authenticated user as an admin
      await collective.addUserWithRole(user, roles.ADMIN, { CreatedByUserId: user.id }, {}, transaction);
      return collective;
    })
    .then(async collective => {
      // Add the host if any
      if (host) {
        await collective.addHost(host, user, {
          shouldAutomaticallyApprove,
          message: args.message,
          applicationData: args.applicationData,
        });
        purgeCacheForCollective(host.slug);
      }

      // Will send an email to the authenticated user OR newly created user
      // - tell them that their collective was successfully created
      // - tell them which fiscal host they picked, if any
      // - tell them the status of their host application
      const remoteUserCollective = await loaders.Collective.byId.load(user.CollectiveId);
      models.Activity.create({
        type: activities.COLLECTIVE_CREATED,
        UserId: user.id,
        CollectiveId: get(host, 'id'),
        data: {
          collective: collective.info,
          host: get(host, 'info'),
          hostPending: collective.approvedAt ? false : true,
          accountType: collective.type === 'FUND' ? 'fund' : 'collective',
          user: {
            email: user.email,
            collective: remoteUserCollective.info,
          },
        },
      });

      return collective;
    });
}

const createCollectiveMutation = {
  type: Collective,
  args: {
    collective: {
      description: 'Information about the collective to create (name, slug, description, tags, ...)',
      type: new GraphQLNonNull(CollectiveCreateInput),
    },
    host: {
      description: 'Reference to the host to apply on creation.',
      type: AccountReferenceInput,
    },
    user: {
      description: 'User information to create along with the collective',
      type: IndividualCreateInput,
    },
    automateApprovalWithGithub: {
      description: 'Whether to trigger the automated approval for Open Source collectives with GitHub.',
      type: GraphQLBoolean,
      defaultValue: false,
    },
    message: {
      type: GraphQLString,
      description: 'A message to attach for the host to review the application',
    },
    applicationData: {
      type: GraphQLJSON,
      description: 'Further information about collective applying to host',
    },
  },
  resolve: (_, args, req) => {
    return createCollective(_, args, req);
  },
};

export default createCollectiveMutation;
