import config from 'config';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { get, pick } from 'lodash';

import POLICIES from '../../../constants/policies';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import { canUseSlug, defaultHostCollective } from '../../../lib/collectivelib';
import * as github from '../../../lib/github';
import { OSCValidator } from '../../../lib/osc-validator';
import { getPolicy } from '../../../lib/policies';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import models, { sequelize } from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { RateLimitExceeded, ValidationFailed } from '../../errors';
import { handleCollectiveImageUploadFromArgs } from '../input/AccountCreateInputImageFields';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLCollectiveCreateInput } from '../input/CollectiveCreateInput';
import { GraphQLIndividualCreateInput } from '../input/IndividualCreateInput';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput';
import { GraphQLCollective } from '../object/Collective';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

async function createCollective(_, args, req) {
  // Ok for non-authenticated users, we only check scope
  checkRemoteUserCanUseAccount(req, { signedOutMessage: 'You need to be logged in to create a collective' });

  let shouldAutomaticallyApprove = false;
  const isProd = config.env === 'production';
  const { remoteUser, loaders } = req;

  let host, validatedRepositoryInfo;

  if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders });
  }

  const rateLimitKey = `collective_create_${remoteUser.id}`;
  const rateLimit = new RateLimit(rateLimitKey, 60, ONE_HOUR_IN_SECONDS, true);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  return sequelize
    .transaction(async transaction => {
      const collectiveData = {
        slug: args.collective.slug.toLowerCase(),
        ...pick(args.collective, ['name', 'description', 'tags', 'githubHandle', 'repositoryUrl']),
        isActive: false,
        CreatedByUserId: remoteUser.id,
        settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
      };

      if (!isProd && args.testPayload) {
        collectiveData.data = args.testPayload.data;
      }

      if (!canUseSlug(collectiveData.slug, remoteUser)) {
        throw new Error(`The slug '${collectiveData.slug}' is not allowed.`);
      }
      const collectiveWithSlug = await models.Collective.findOne({ where: { slug: collectiveData.slug }, transaction });

      if (collectiveWithSlug) {
        throw new ValidationFailed('An account already exists for this URL, please choose another one.', null, {
          extraInfo: { slugExists: true },
        });
      }

      // Throw validation error if you have not invited enough admins
      const minAdminsPolicy = await getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
      const requiredAdmins = minAdminsPolicy?.numberOfAdmins || 0;
      const adminsIncludingInvitedCount = (args.inviteMembers?.length || 0) + 1;
      if (requiredAdmins > adminsIncludingInvitedCount) {
        throw new ValidationFailed(`This host policy requires at least ${requiredAdmins} admins for this account.`);
      }

      // Trigger automated Github approval when repository is on github.com (or using deprecated automateApprovaWithGithub argument )
      const repositoryUrl = args.applicationData?.repositoryUrl || args.collective.repositoryUrl;
      if (args.applicationData?.useGithubValidation) {
        const githubHandle = github.getGithubHandleFromUrl(repositoryUrl) || args.collective.githubHandle;
        host = await defaultHostCollective('opensource');

        try {
          // For e2e testing, we enable testuser+(admin|member|host)@opencollective.com to create collective without github validation
          const bypassGithubValidation = !isProd && remoteUser.email.match(/.*test.*@opencollective.com$/);

          if (!bypassGithubValidation) {
            const githubAccount = await models.ConnectedAccount.findOne(
              { where: { CollectiveId: remoteUser.CollectiveId, service: 'github' } },
              { transaction },
            );
            if (githubAccount) {
              // In e2e/CI environment, checkGithubAdmin will be stubbed
              await github.checkGithubAdmin(githubHandle, githubAccount.token);

              if (githubHandle.includes('/')) {
                validatedRepositoryInfo = OSCValidator(
                  await github.getValidatorInfo(githubHandle, githubAccount.token),
                );
              }
            }
          }
          const { allValidationsPassed } = validatedRepositoryInfo || {};
          shouldAutomaticallyApprove = allValidationsPassed || bypassGithubValidation;
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

      let collective;
      try {
        collective = await models.Collective.create(collectiveData, { transaction });
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          throw new ValidationFailed('An account already exists for this URL, please choose another one.', null, {
            extraInfo: { slugExists: true },
          });
        } else {
          throw error;
        }
      }

      // Add authenticated user as an admin
      if (!args.skipDefaultAdmin) {
        await collective.addUserWithRole(remoteUser, roles.ADMIN, { CreatedByUserId: remoteUser.id }, {}, transaction);
      }

      if (args.inviteMembers && args.inviteMembers.length) {
        await processInviteMembersInput(collective, args.inviteMembers, {
          skipDefaultAdmin: args.skipDefaultAdmin,
          transaction,
          supportedRoles: MEMBER_INVITATION_SUPPORTED_ROLES,
          user: remoteUser,
        });
      }

      // Add location
      if (args.collective.location) {
        await collective.setLocation(args.collective.location, transaction);
      }

      const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.collective);
      if (avatar || banner) {
        await collective.update(
          { image: avatar?.url ?? collective.image, backgroundImage: banner?.url ?? collective.backgroundImage },
          { transaction, hooks: false },
        );
      }

      return collective;
    })
    .then(async collective => {
      // We're out of the main SQL transaction now

      // Automated approval if the creator is Github Sponsors
      if (req.remoteUser) {
        const remoteUserCollective = await req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
        if (remoteUserCollective.slug === 'github-sponsors') {
          shouldAutomaticallyApprove = true;
        }
      }

      // In test/dev environments, we can skip the approval process
      if (args.skipApprovalTestOnly && !isProd) {
        shouldAutomaticallyApprove = true;
      }

      // Add the host if any
      if (host) {
        await collective.addHost(host, remoteUser, {
          shouldAutomaticallyApprove,
          message: args.message,
          applicationData: { ...args.applicationData, validatedRepositoryInfo },
        });
        purgeCacheForCollective(host.slug);
      }

      // Will send an email to the authenticated user OR newly created user
      // - tell them that their collective was successfully created
      // - tell them which fiscal host they picked, if any
      // - tell them the status of their host application
      if (!args.skipDefaultAdmin) {
        const remoteUserCollective = await loaders.Collective.byId.load(remoteUser.CollectiveId);
        collective.generateCollectiveCreatedActivity(remoteUser, req.userToken, {
          collective: collective.info,
          host: get(host, 'info'),
          hostPending: collective.approvedAt ? false : true,
          accountType: collective.type === 'FUND' ? 'fund' : 'collective',
          user: {
            email: remoteUser.email,
            collective: remoteUserCollective.info,
          },
        });
      }

      return collective;
    });
}

const createCollectiveMutation = {
  type: GraphQLCollective,
  description: 'Create a Collective. Scope: "account".',
  args: {
    collective: {
      description: 'Information about the collective to create (name, slug, description, tags, ...)',
      type: new GraphQLNonNull(GraphQLCollectiveCreateInput),
    },
    host: {
      description: 'Reference to the host to apply on creation.',
      type: GraphQLAccountReferenceInput,
    },
    user: {
      description: 'User information to create along with the collective',
      type: GraphQLIndividualCreateInput,
    },
    message: {
      type: GraphQLString,
      description: 'A message to attach for the host to review the application',
    },
    applicationData: {
      type: GraphQLJSON,
      description: 'Further information about collective applying to host',
    },
    testPayload: {
      type: GraphQLJSON,
      description: 'Additional data for the collective creation. This argument has no effect in production',
    },
    skipDefaultAdmin: {
      description: 'Create a Collective without a default admin (authenticated user or user)',
      type: GraphQLBoolean,
      defaultValue: false,
    },
    inviteMembers: {
      type: new GraphQLList(GraphQLInviteMemberInput),
      description: 'List of members to invite on Collective creation.',
    },
    skipApprovalTestOnly: {
      description: 'Marks the collective as approved directly. Only available in test/CI environments.',
      type: GraphQLBoolean,
      defaultValue: false,
    },
  },
  resolve: (_, args, req) => {
    return createCollective(_, args, req);
  },
};

export default createCollectiveMutation;
