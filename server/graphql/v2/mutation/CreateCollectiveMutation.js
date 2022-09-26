import config from 'config';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { get, pick } from 'lodash';

import activities from '../../../constants/activities';
import POLICIES from '../../../constants/policies';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import * as github from '../../../lib/github';
import { getPolicy } from '../../../lib/policies';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { defaultHostCollective } from '../../../lib/utils';
import models, { sequelize } from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { processInviteMembersInput } from '../../common/members';
import { checkScope } from '../../common/scope-check';
import { RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CollectiveCreateInput } from '../input/CollectiveCreateInput';
import { IndividualCreateInput } from '../input/IndividualCreateInput';
import { InviteMemberInput } from '../input/InviteMemberInput';
import { Collective } from '../object/Collective';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

async function createCollective(_, args, req) {
  // Ok for non-authenticated users, we only check scope
  if (!checkScope(req, 'account')) {
    throw new Unauthorized('The User Token is not allowed for operations in scope "account".');
  }

  let shouldAutomaticallyApprove = false;
  const isProd = config.env === 'production';
  const { remoteUser, loaders } = req;

  let user = remoteUser,
    host;

  if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders });
  }

  const rateLimitKey = remoteUser ? `collective_create_${remoteUser.id}` : `collective_create_ip_${req.ip}`;
  const rateLimit = new RateLimit(rateLimitKey, 60, ONE_HOUR_IN_SECONDS, true);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
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
        ...pick(args.collective, ['name', 'description', 'tags', 'githubHandle', 'repositoryUrl']),
        isActive: false,
        CreatedByUserId: user.id,
        settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
      };

      if (!isProd && args.testPayload) {
        collectiveData.data = args.testPayload.data;
      }

      if (isCollectiveSlugReserved(collectiveData.slug)) {
        throw new Error(`The slug '${collectiveData.slug}' is not allowed.`);
      }
      const collectiveWithSlug = await models.Collective.findOne({ where: { slug: collectiveData.slug }, transaction });

      if (collectiveWithSlug) {
        throw new ValidationFailed('An account already exists for this URL, please choose another one.', null, {
          extraInfo: { slugExists: true },
        });
      }

      // Handle GitHub automated approval and apply to the Open Source Collective Host
      const githubHandle = github.getGithubHandleFromUrl(collectiveData.repositoryUrl) || collectiveData.githubHandle;
      if (args.automateApprovalWithGithub) {
        const opensourceHost = defaultHostCollective('opensource');
        host = await loaders.Collective.byId.load(opensourceHost.CollectiveId);
        try {
          // For e2e testing, we enable testuser+(admin|member|host)@opencollective.com to create collective without github validation
          const bypassGithubValidation = !isProd && user.email.match(/.*test.*@opencollective.com$/);
          if (!bypassGithubValidation) {
            const githubAccount = await models.ConnectedAccount.findOne(
              { where: { CollectiveId: user.CollectiveId, service: 'github' } },
              { transaction },
            );
            if (!githubAccount) {
              throw new Error('You must have a connected GitHub Account to create a collective with GitHub.');
            }
            // In e2e/CI environment, checkGithubAdmin and checkGithubStars will be stubbed
            await github.checkGithubAdmin(githubHandle, githubAccount.token);
            await github.checkGithubStars(githubHandle, githubAccount.token);
          }
          const policy = getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
          shouldAutomaticallyApprove = policy?.numberOfAdmins > 1 ? false : true;
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
        await collective.addUserWithRole(user, roles.ADMIN, { CreatedByUserId: user.id }, {}, transaction);
      }

      if (args.inviteMembers && args.inviteMembers.length) {
        await processInviteMembersInput(collective, args.inviteMembers, {
          skipDefaultAdmin: args.skipDefaultAdmin,
          transaction,
          supportedRoles: MEMBER_INVITATION_SUPPORTED_ROLES,
          user,
        });
      }

      return collective;
    })
    .then(async collective => {
      // We're out of the main SQL transaction now

      // Automated approval if the creator is Github Sponsors
      if (req.remoteUser) {
        const remoteUserCollective = await models.Collective.findByPk(req.remoteUser.CollectiveId);
        if (remoteUserCollective.slug === 'github-sponsors') {
          shouldAutomaticallyApprove = true;
        }
      }

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
      if (!args.skipDefaultAdmin) {
        const remoteUserCollective = await loaders.Collective.byId.load(user.CollectiveId);
        models.Activity.create({
          type: activities.COLLECTIVE_CREATED,
          UserId: user.id,
          UserTokenId: req.userToken?.id,
          CollectiveId: get(host, 'id'), // TODO(InconsistentActivities): Should be collective.id
          HostCollectiveId: get(host, 'id'),
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
      }

      return collective;
    });
}

const createCollectiveMutation = {
  type: Collective,
  description: 'Create a Collective. Scope: "account".',
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
      type: new GraphQLList(InviteMemberInput),
      description: 'List of members to invite on Collective creation.',
    },
  },
  resolve: (_, args, req) => {
    return createCollective(_, args, req);
  },
};

export default createCollectiveMutation;
