import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { activities } from '../../../constants';
import { types as CollectiveType } from '../../../constants/collectives';
import { purgeAllCachesForAccount, purgeCacheForCollective } from '../../../lib/cache';
import emailLib, { NO_REPLY_EMAIL } from '../../../lib/email';
import { stripHTML } from '../../../lib/sanitize-html';
import models, { sequelize } from '../../../models';
import { HostApplicationStatus } from '../../../models/HostApplication';
import { NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { ProcessHostApplicationAction } from '../enum/ProcessHostApplicationAction';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
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
    description: 'Apply to an host with a collective',
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
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in');
      }

      const collective = await fetchAccountWithReference(args.collective);
      if (!collective) {
        throw new NotFound('Collective not found');
      }
      if (![CollectiveType.COLLECTIVE, CollectiveType.FUND].includes(collective.type)) {
        throw new Error('Account must be a collective or a fund');
      }
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized('You need to be an Admin of the account');
      }

      const host = await fetchAccountWithReference(args.host);
      if (!host) {
        throw new NotFound('Host not found');
      }

      // No need to check the balance, this is being handled in changeHost, along with most other checks

      return collective.changeHost(host.id, req.remoteUser, {
        message: args.message,
        applicationData: args.applicationData,
      });
    },
  },
  processHostApplication: {
    type: new GraphQLNonNull(ProcessHostApplicationResponse),
    description: 'Reply to a host application',
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
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

      if (!req.remoteUser?.isAdmin(host.id)) {
        throw new Unauthorized('You need to be authenticated as a host admin to perform this action');
      } else if (account.HostCollectiveId !== host.id) {
        throw new NotFound(`No application found for ${account.slug} in ${host.slug}`);
      } else if (account.approvedAt) {
        throw new ValidationFailed('This collective application has already been approved');
      }

      switch (args.action) {
        case 'APPROVE':
          return { account: await approveApplication(host, account, req.remoteUser) };
        case 'REJECT':
          return { account: rejectApplication(host, account, req.remoteUser, args.message) };
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
    description: '[Root only] Removes the host for an account',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The account to unhost',
      },
    },
    resolve: async (_, args, req: express.Request): Promise<Record<string, unknown>> => {
      if (!req.remoteUser?.isRoot()) {
        throw new Unauthorized('You need to be a root user to unhost an account');
      }

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const host = await req.loaders.Collective.host.load(account.id);
      if (!host) {
        throw new ValidationFailed('This account has no host');
      }

      await account.changeHost(null);
      await Promise.all([purgeAllCachesForAccount(account), purgeAllCachesForAccount(host)]);
      return account.reload();
    },
  },
};

const approveApplication = async (host, collective, remoteUser) => {
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
    UserId: remoteUser.id,
    CollectiveId: host.id,
    data: {
      collective: collective.info,
      host: host.info,
      user: {
        email: remoteUser.email,
      },
    },
  });

  // Purge cache and change the status of the application
  purgeCacheForCollective(collective.slug);
  await models.HostApplication.updatePendingApplications(host, collective, HostApplicationStatus.APPROVED);
  return collective;
};

const rejectApplication = async (host, collective, remoteUser, reason: string) => {
  if (collective.isActive) {
    throw new Error('This application has already been approved');
  }

  // Reset host for collective & its children
  await collective.changeHost(null, remoteUser);

  // Notify collective admins
  const cleanReason = reason && stripHTML(reason).trim();
  await models.Activity.create({
    type: activities.COLLECTIVE_REJECTED,
    UserId: remoteUser.id,
    CollectiveId: host.id,
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
    'host.application.contact',
    NO_REPLY_EMAIL,
    {
      host: host.info,
      collective: collective.info,
      message,
    },
    {
      bcc: adminUsers.map(u => u.email),
    },
  );
};

const sendPublicMessage = async (host, collective, user, message: string): Promise<typeof models.Conversation> => {
  const title = `About your application to ${host.name}`;
  const tags = ['host'];
  return models.Conversation.createWithComment(user, collective, title, message, tags);
};

export default HostApplicationMutations;
