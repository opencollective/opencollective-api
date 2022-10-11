import config from 'config';
import express from 'express';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { activities } from '../../../constants';
import { types as CollectiveType } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import POLICIES from '../../../constants/policies';
import MemberRoles from '../../../constants/roles';
import { purgeAllCachesForAccount, purgeCacheForCollective } from '../../../lib/cache';
import emailLib from '../../../lib/email';
import * as github from '../../../lib/github';
import { OSCValidator } from '../../../lib/osc-validator';
import { getPolicy } from '../../../lib/policies';
import { stripHTML } from '../../../lib/sanitize-html';
import models, { sequelize } from '../../../models';
import { HostApplicationStatus } from '../../../models/HostApplication';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseHost, checkScope } from '../../common/scope-check';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { ProcessHostApplicationAction } from '../enum/ProcessHostApplicationAction';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { InviteMemberInput } from '../input/InviteMemberInput';
import { Account } from '../interface/Account';
import Conversation from '../object/Conversation';

const ProcessHostApplicationResponse = new GraphQLObjectType({
  name: 'ProcessHostApplicationResponse',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(Account),
      description: 'The account that applied to the host',
    },
    conversation: {
      type: Conversation,
      description: 'When sending a public message, this field will have the info about the conversation created',
    },
  }),
});

const HostApplicationMutations = {
  applyToHost: {
    type: new GraphQLNonNull(Account),
    description: 'Apply to an host with a collective. Scope: "account".',
    args: {
      collective: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account applying to the host.',
      },
      host: {
        type: new GraphQLNonNull(AccountReferenceInput),
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
        type: new GraphQLList(InviteMemberInput),
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
      const requiredAdmins = getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS)?.numberOfAdmins || 0;
      const validAdminsCount = adminCount + adminInvitationCount + (args.inviteMembers?.length || 0);
      if (requiredAdmins > validAdminsCount) {
        throw new Forbidden(`This host policy requires at least ${requiredAdmins} admins for this account.`);
      }

      let validatedRepositoryInfo,
        shouldAutomaticallyApprove = false;
      const { repositoryUrl } = args.applicationData || {};

      if (repositoryUrl && repositoryUrl.contains('https://github.com/')) {
        const githubHandle = github.getGithubHandleFromUrl(repositoryUrl);

        try {
          // For e2e testing, we enable testuser+(admin|member|host)@opencollective.com to create collective without github validation
          const bypassGithubValidation = !isProd && req.remoteUser.email.match(/.*test.*@opencollective.com$/);
          if (!bypassGithubValidation) {
            const githubAccount = await models.ConnectedAccount.findOne({
              where: { CollectiveId: req.remoteUser.CollectiveId, service: 'github' },
            });
            if (!githubAccount) {
              throw new Error('You must have a connected GitHub Account to apply to a host with GitHub.');
            }
            // In e2e/CI environment, checkGithubAdmin will be stubbed
            await github.checkGithubAdmin(githubHandle, githubAccount.token);

            if (githubHandle.includes('/')) {
              validatedRepositoryInfo = OSCValidator(await github.getValidatorInfo(githubHandle, githubAccount.token));
            }
          }

          shouldAutomaticallyApprove = !!validatedRepositoryInfo?.allValidationsPassed;
        } catch (error) {
          throw new ValidationFailed(error.message);
        }

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
    type: new GraphQLNonNull(ProcessHostApplicationResponse),
    description: 'Reply to a host application. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The account that applied to the host',
      },
      host: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The host concerned by the application',
      },
      action: {
        type: new GraphQLNonNull(ProcessHostApplicationAction),
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
    type: new GraphQLNonNull(Account),
    description: 'Removes the host for an account',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The account to unhost',
      },
      message: {
        type: GraphQLString,
      },
    },
    resolve: async (_, args, req: express.Request): Promise<Record<string, unknown>> => {
      checkRemoteUserCanUseHost(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (account.ParentCollectiveId) {
        throw new ValidationFailed(`Cannot unhost projects/events with a parent. Please unhost the parent instead.`);
      }

      const host = await req.loaders.Collective.host.load(account.id);
      if (!host) {
        return account;
      }
      if (!req.remoteUser.isAdminOfCollective(host) && !(req.remoteUser.isRoot() && checkScope(req, 'root'))) {
        throw new Unauthorized();
      }

      await account.changeHost(null);

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
        },
      });

      await Promise.all([purgeAllCachesForAccount(account), purgeAllCachesForAccount(host)]);
      return account.reload();
    },
  },
};

const approveApplication = async (host, collective, req) => {
  const where = {
    CollectiveId: collective.id,
    role: MemberRoles.ADMIN,
  };

  const [adminCount, adminInvitationCount] = await Promise.all([
    models.Member.count({ where }),
    models.MemberInvitation.count({ where }),
  ]);

  if (getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS)?.numberOfAdmins > adminCount + adminInvitationCount) {
    throw new Forbidden(
      `Your host policy requires at least ${
        getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS).numberOfAdmins
      } admins for this account.`,
    );
  }
  // Run updates in a transaction to make sure we don't end up approving half accounts if something goes wrong
  await sequelize.transaction(async transaction => {
    const newAccountData = { isActive: true, approvedAt: new Date(), HostCollectiveId: host.id };

    // Approve all events and projects created by this collective
    await models.Collective.update(
      newAccountData,
      { where: { ParentCollectiveId: collective.id }, hooks: false },
      { transaction },
    );

    // Approve the collective
    await collective.update(newAccountData, { transaction });
  });

  // Send a notification to collective admins
  await models.Activity.create({
    type: activities.COLLECTIVE_APPROVED,
    UserId: req.remoteUser?.id,
    UserTokenId: req.userToken?.id,
    CollectiveId: host.id, // TODO(InconsistentActivities): Should be collective.id
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
  const policy = getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
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
    CollectiveId: host.id, // TODO(InconsistentActivities): Should be CollectiveId
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

const sendPublicMessage = async (host, collective, user, message: string): Promise<typeof models.Conversation> => {
  const title = `About your application to ${host.name}`;
  const tags = ['host'];
  return models.Conversation.createWithComment(user, collective, title, message, tags);
};

export default HostApplicationMutations;
