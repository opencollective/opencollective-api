import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { activities } from '../../../constants';
import { CollectiveType } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import POLICIES from '../../../constants/policies';
import MemberRoles from '../../../constants/roles';
import { purgeAllCachesForAccount, purgeCacheForCollective } from '../../../lib/cache';
import emailLib from '../../../lib/email';
import * as github from '../../../lib/github';
import { OSCValidator, ValidatedRepositoryInfo } from '../../../lib/osc-validator';
import { getPolicy } from '../../../lib/policies';
import { stripHTML } from '../../../lib/sanitize-html';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Collective, Op, sequelize } from '../../../models';
import ConversationModel from '../../../models/Conversation';
import { HostApplicationStatus } from '../../../models/HostApplication';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseHost, checkScope } from '../../common/scope-check';
import { Forbidden, NotFound, ValidationFailed } from '../../errors';
import { GraphQLProcessHostApplicationAction } from '../enum/ProcessHostApplicationAction';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput';
import { GraphQLAccount } from '../interface/Account';
import GraphQLConversation from '../object/Conversation';

const GraphQLProcessHostApplicationResponse = new GraphQLObjectType({
  name: 'ProcessHostApplicationResponse',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The account that applied to the host',
    },
    conversation: {
      type: GraphQLConversation,
      description: 'When sending a public message, this field will have the info about the conversation created',
    },
  }),
});

const HostApplicationMutations = {
  applyToHost: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Apply to an host with a collective. Scope: "account".',
    args: {
      collective: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account applying to the host.',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Host to apply to.',
      },
      message: {
        type: GraphQLString,
        description: 'A message to attach for the host to review the application',
      },
      applicationData: {
        type: GraphQLJSON,
        description: 'Further information about collective applying to host',
      },
      inviteMembers: {
        type: new GraphQLList(GraphQLInviteMemberInput),
        description: 'A list of members to invite when applying to the host',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const collective = await fetchAccountWithReference(args.collective);
      if (!collective) {
        throw new NotFound('Collective not found');
      }
      if (![CollectiveType.COLLECTIVE, CollectiveType.FUND].includes(collective.type)) {
        throw new Error('Account must be a collective or a fund');
      }
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden('You need to be an Admin of the account');
      }

      await twoFactorAuthLib.enforceForAccount(req, collective);

      const host = await fetchAccountWithReference(args.host);
      if (!host) {
        throw new NotFound('Host not found');
      }

      const isProd = config.env === 'production';

      const where = {
        CollectiveId: collective.id,
        role: MemberRoles.ADMIN,
      };
      const [adminCount, adminInvitationCount] = await Promise.all([
        models.Member.count({ where }),
        models.MemberInvitation.count({ where }),
      ]);
      const minAdminsPolicy = await getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
      const validAdminsCount = adminCount + adminInvitationCount + (args.inviteMembers?.length || 0);
      if ((minAdminsPolicy || 0) > validAdminsCount) {
        throw new Forbidden(`This host policy requires at least ${minAdminsPolicy} admins for this account.`);
      }

      let validatedRepositoryInfo: ValidatedRepositoryInfo,
        shouldAutomaticallyApprove = false;

      // Trigger automated Github approval when repository is on github.com
      const repositoryUrl = args.applicationData?.repositoryUrl;
      if (args.applicationData?.useGithubValidation) {
        const githubHandle = github.getGithubHandleFromUrl(repositoryUrl);
        try {
          // For e2e testing, we enable testuser+(admin|member|host)@opencollective.com to create collective without github validation
          const bypassGithubValidation = !isProd && req.remoteUser.email.match(/.*test.*@opencollective.com$/);
          if (!bypassGithubValidation) {
            const githubAccount = await models.ConnectedAccount.findOne({
              where: { CollectiveId: req.remoteUser.CollectiveId, service: 'github' },
            });
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
          shouldAutomaticallyApprove = Boolean(allValidationsPassed || bypassGithubValidation);
        } catch (error) {
          throw new ValidationFailed(error.message);
        }
      }

      if (repositoryUrl) {
        collective.repositoryUrl = repositoryUrl;
        await collective.save();
      }

      // No need to check the balance, this is being handled in changeHost, along with most other checks
      const response = await collective.changeHost(host.id, req.remoteUser, {
        shouldAutomaticallyApprove,
        message: args.message,
        applicationData: { ...args.applicationData, validatedRepositoryInfo },
      });

      if (args.inviteMembers && args.inviteMembers.length) {
        await processInviteMembersInput(collective, args.inviteMembers, {
          supportedRoles: [MemberRoles.ADMIN],
          user: req.remoteUser,
        });
      }

      return response;
    },
  },
  processHostApplication: {
    type: new GraphQLNonNull(GraphQLProcessHostApplicationResponse),
    description: 'Reply to a host application. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account that applied to the host',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host concerned by the application',
      },
      action: {
        type: new GraphQLNonNull(GraphQLProcessHostApplicationAction),
        description: 'What to do with the application',
      },
      message: {
        type: GraphQLString,
        description: 'A message to attach as a reason for the action',
      },
    },
    resolve: async (_, args, req: express.Request): Promise<Record<string, unknown>> => {
      checkRemoteUserCanUseHost(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

      if (!req.remoteUser.isAdmin(host.id)) {
        throw new Forbidden('You need to be authenticated as a host admin to perform this action');
      } else if (account.HostCollectiveId !== host.id) {
        throw new NotFound(`No application found for ${account.slug} in ${host.slug}`);
      } else if (account.approvedAt) {
        throw new ValidationFailed('This collective application has already been approved');
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });

      switch (args.action) {
        case 'APPROVE':
          return { account: await approveApplication(host, account, req) };
        case 'REJECT':
          return { account: rejectApplication(host, account, req, args.message) };
        case 'SEND_PRIVATE_MESSAGE':
          await sendPrivateMessage(host, account, args.message);
          return { account };
        case 'SEND_PUBLIC_MESSAGE':
          return {
            account,
            conversation: await sendPublicMessage(host, account, req.remoteUser, args.message),
          };
        default:
          throw new ValidationFailed(`Action ${args.action} is not supported yet`);
      }
    },
  },
  removeHost: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Removes the host for an account',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to unhost',
      },
      message: {
        type: GraphQLString,
        description: 'An optional message to explain the reason for unhosting',
      },
      messageForContributors: {
        type: GraphQLString,
        description: 'An optional HTML message to provide additional context for contributors',
      },
      pauseContributions: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If true, contributions will be paused rather than canceled',
        defaultValue: true,
      },
    },
    resolve: async (_, args, req: express.Request): Promise<Collective> => {
      checkRemoteUserCanUseHost(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (account.ParentCollectiveId) {
        throw new ValidationFailed(`Cannot unhost projects/events with a parent. Please unhost the parent instead.`);
      }

      const host = await req.loaders.Collective.host.load(account);
      if (!host) {
        return account;
      }

      const isHostAdmin = req.remoteUser.isAdminOfCollective(host);
      const isAccountAdmin = req.remoteUser.isAdminOfCollective(account);
      if (!isHostAdmin && !isAccountAdmin && !(req.remoteUser.isRoot() && checkScope(req, 'root'))) {
        throw new Forbidden('Only the host admin or the account admin can trigger this action');
      }

      await twoFactorAuthLib.enforceForAccountsUserIsAdminOf(req, [account, host], { alwaysAskForToken: true });

      await account.changeHost(null, req.remoteUser, {
        pauseContributions: args.pauseContributions,
        messageForContributors: args.messageForContributors,
        messageSource: isHostAdmin ? 'HOST' : 'COLLECTIVE',
      });

      await models.Activity.create({
        type: activities.COLLECTIVE_UNHOSTED,
        UserId: req.remoteUser?.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          collective: account.info,
          host: host.info,
          message: args.message,
          isHostAdmin,
          isAccountAdmin,
        },
      });

      await Promise.all([purgeAllCachesForAccount(account), purgeAllCachesForAccount(host)]);
      return account.reload();
    },
  },
};

const approveApplication = async (host, collective, req) => {
  // Check minimum number of admins
  const countAdminsWhere = {
    CollectiveId: collective.id,
    role: MemberRoles.ADMIN,
  };

  const [adminCount, adminInvitationCount] = await Promise.all([
    models.Member.count({ where: countAdminsWhere }),
    models.MemberInvitation.count({ where: countAdminsWhere }),
  ]);

  const minAdminsPolicy = await getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
  if (minAdminsPolicy?.numberOfAdmins > adminCount + adminInvitationCount) {
    throw new Forbidden(
      `Your host policy requires at least ${minAdminsPolicy.numberOfAdmins} admins for this account.`,
    );
  }
  // Run updates in a transaction to make sure we don't end up approving half accounts if something goes wrong
  await sequelize.transaction(async transaction => {
    const newAccountData = {
      isActive: true,
      approvedAt: new Date(),
      HostCollectiveId: host.id,
      currency: host.currency,
    };

    // Approve all events and projects created by this collective
    await models.Collective.update(newAccountData, {
      where: { ParentCollectiveId: collective.id },
      hooks: false,
      transaction,
    });

    // Convert all active tiers to host currency
    const children = await collective.getChildren({ attributes: ['id'] });
    await models.Tier.update(
      { currency: host.currency },
      {
        validate: false,
        transaction,
        where: {
          CollectiveId: [collective.id, ...children.map(c => c.id)],
          currency: { [Op.not]: host.currency },
        },
      },
    );

    // Approve the collective
    await collective.update(newAccountData, { transaction });
  });

  // Send a notification to collective admins
  await models.Activity.create({
    type: activities.COLLECTIVE_APPROVED,
    UserId: req.remoteUser?.id,
    UserTokenId: req.userToken?.id,
    CollectiveId: collective.id,
    HostCollectiveId: host.id,
    data: {
      collective: collective.info,
      host: host.info,
      user: {
        email: req.remoteUser?.email,
      },
    },
  });

  // If collective does not have enough admins, block it from receiving Contributions
  const policy = await getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
  if (policy?.freeze && policy.numberOfAdmins > adminCount) {
    await collective.disableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
  }

  // Purge cache and change the status of the application
  purgeCacheForCollective(collective.slug);
  await models.HostApplication.updatePendingApplications(host, collective, HostApplicationStatus.APPROVED);
  return collective;
};

const rejectApplication = async (host, collective, req, reason: string) => {
  if (collective.isActive) {
    throw new Error('This application has already been approved');
  }
  const { remoteUser } = req;

  // Reset host for collective & its children
  await collective.changeHost(null, remoteUser);

  // Notify collective admins
  const cleanReason = reason && stripHTML(reason).trim();
  await models.Activity.create({
    type: activities.COLLECTIVE_REJECTED,
    UserId: remoteUser.id,
    UserTokenId: req.userToken?.id,
    CollectiveId: collective.id,
    HostCollectiveId: host.id,
    data: {
      collective: collective.info,
      host: host.info,
      user: {
        email: remoteUser.email,
      },
      rejectionReason: cleanReason || null,
    },
  });

  // Purge cache and change the status of the application
  purgeCacheForCollective(collective.slug);
  await models.HostApplication.updatePendingApplications(host, collective, HostApplicationStatus.REJECTED);
  return collective;
};

const sendPrivateMessage = async (host, collective, message: string): Promise<void> => {
  const adminUsers = await collective.getAdminUsers();
  await emailLib.send(
    activities.HOST_APPLICATION_CONTACT,
    config.email.noReply,
    {
      host: host.info,
      collective: collective.info,
      message,
    },
    {
      bcc: adminUsers.map(u => u.email),
      replyTo: host.data?.replyToEmail || undefined,
    },
  );
};

const sendPublicMessage = async (host, collective, user, message: string): Promise<ConversationModel> => {
  const title = `About your application to ${host.name}`;
  const tags = ['host'];
  return models.Conversation.createWithComment(user, collective, title, message, tags);
};

export default HostApplicationMutations;
