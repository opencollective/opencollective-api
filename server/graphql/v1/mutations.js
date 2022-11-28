import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import twoFactorAuthLib from '../../lib/two-factor-authentication';
import models from '../../models';
import { bulkCreateGiftCards, createGiftCardsForEmails } from '../../paymentProviders/opencollective/giftcard';
import { sendMessage } from '../common/collective';
import { editPublicMessage } from '../common/members';
import { createUser } from '../common/user';
import { NotFound, Unauthorized } from '../errors';

import * as applicationMutations from './mutations/applications';
import * as backyourstackMutations from './mutations/backyourstack';
import {
  activateBudget,
  activateCollectiveAsHost,
  archiveCollective,
  createCollective,
  createCollectiveFromGithub,
  deactivateBudget,
  deactivateCollectiveAsHost,
  deleteCollective,
  editCollective,
  unarchiveCollective,
} from './mutations/collectives';
import { editConnectedAccount } from './mutations/connectedAccounts';
import { createWebhook, deleteNotification, editWebhooks } from './mutations/notifications';
import { confirmOrder, createOrder, refundTransaction } from './mutations/orders';
import * as paymentMethodsMutation from './mutations/paymentMethods';
import { editTier, editTiers } from './mutations/tiers';
import { confirmUserEmail, updateUserEmail } from './mutations/users';
import { ApplicationInputType, ApplicationType } from './Application';
import { CollectiveInterfaceType } from './CollectiveInterface';
import {
  CollectiveInputType,
  ConfirmOrderInputType,
  ConnectedAccountInputType,
  MemberInputType,
  NotificationInputType,
  OrderInputType,
  StripeCreditCardDataInputType,
  TierInputType,
  UserInputType,
} from './inputTypes';
import { TransactionInterfaceType } from './TransactionInterface';
import {
  ConnectedAccountType,
  MemberType,
  NotificationType,
  OrderType,
  PaymentMethodType,
  TierType,
  UserType,
} from './types';

const mutations = {
  createCollective: {
    type: CollectiveInterfaceType,
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    resolve(_, args, req) {
      return createCollective(_, args, req);
    },
  },
  createCollectiveFromGithub: {
    type: CollectiveInterfaceType,
    deprecationReason: '2022-05-03: This mutation is deprecated and can only be used in test environments.',
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    resolve(_, args, req) {
      return createCollectiveFromGithub(_, args, req);
    },
  },
  editCollective: {
    type: CollectiveInterfaceType,
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    resolve(_, args, req) {
      return editCollective(_, args, req);
    },
  },
  deleteCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      return deleteCollective(_, args, req);
    },
  },
  deleteUserCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      return deleteCollective(_, args, req);
    },
  },
  archiveCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      return archiveCollective(_, args, req);
    },
  },
  unarchiveCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      return unarchiveCollective(_, args, req);
    },
  },

  sendMessageToCollective: {
    type: new GraphQLObjectType({
      name: 'SendMessageToCollectiveResult',
      fields: {
        success: { type: GraphQLBoolean },
      },
    }),
    deprecationReason: '2022-08-01: Please use the sendMessage mutation from GraphQL v2 instead.',
    args: {
      collectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      message: { type: new GraphQLNonNull(GraphQLString) },
      subject: { type: GraphQLString },
    },
    async resolve(_, args, req) {
      const collective = await models.Collective.findByPk(args.collectiveId);

      return sendMessage({ req, args, collective, isGqlV2: false });
    },
  },
  createUser: {
    description: 'Create a user with an optional organization.',
    type: new GraphQLObjectType({
      name: 'CreateUserResult',
      fields: {
        user: { type: UserType },
        organization: { type: CollectiveInterfaceType },
      },
    }),
    args: {
      user: {
        type: new GraphQLNonNull(UserInputType),
        description: 'The user info',
      },
      organization: {
        type: CollectiveInputType,
        description: 'An optional organization to create alongside the user',
      },
      redirect: {
        type: GraphQLString,
        description: 'The redirect URL for the login email sent to the user',
        defaultValue: '/',
      },
      websiteUrl: {
        type: GraphQLString,
        description: 'The website URL originating the request',
      },
      throwIfExists: {
        type: GraphQLBoolean,
        description: 'If set to false, will act like just like a Sign In and returns the user',
        defaultValue: true,
      },
      sendSignInLink: {
        type: GraphQLBoolean,
        description: 'If true, a signIn link will be sent to the user',
        defaultValue: true,
      },
    },
    resolve(_, args, req) {
      return createUser(args.user, {
        organizationData: args.organization,
        sendSignInLink: args.sendSignInLink,
        throwIfExists: args.throwIfExists,
        redirect: args.redirect,
        websiteUrl: args.websiteUrl,
        creationRequest: {
          ip: req.ip,
          userAgent: req.header('user-agent'),
        },
      });
    },
  },
  updateUserEmail: {
    type: UserType,
    description: 'Update the email address for logged in user',
    args: {
      email: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The new email address for user',
      },
    },
    resolve: async (_, { email }, req) => {
      await twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
      return updateUserEmail(req.remoteUser, email);
    },
  },
  confirmUserEmail: {
    type: UserType,
    description: 'Confirm the new user email from confirmation token',
    args: {
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: "User's emailConfirmationToken",
      },
    },
    resolve: (_, { token }) => {
      return confirmUserEmail(token);
    },
  },
  editConnectedAccount: {
    type: ConnectedAccountType,
    args: {
      connectedAccount: { type: new GraphQLNonNull(ConnectedAccountInputType) },
    },
    resolve(_, args, req) {
      return editConnectedAccount(req.remoteUser, args.connectedAccount);
    },
  },
  editTier: {
    type: TierType,
    description: 'Update a single tier',
    args: {
      tier: {
        type: new GraphQLNonNull(TierInputType),
        description: 'The tier to update',
      },
    },
    resolve(_, args, req) {
      return editTier(_, args, req);
    },
  },
  editTiers: {
    type: new GraphQLList(TierType),
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      tiers: { type: new GraphQLList(TierInputType) },
    },
    resolve(_, args, req) {
      return editTiers(_, args, req);
    },
  },
  editCoreContributors: {
    type: CollectiveInterfaceType,
    description: 'Updates all the core contributors (role = ADMIN or MEMBER) for this collective.',
    deprecationReason: '2021-07-02: Please use inviteMember, editMember or removeMember mutations from GQLV2',
    args: {
      collectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      members: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberInputType))) },
    },
    async resolve(_, args, req) {
      const collective = await models.Collective.findByPk(args.collectiveId);
      if (!collective) {
        throw new NotFound();
      } else if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized();
      } else {
        await collective.editMembers(args.members, {
          CreatedByUserId: req.remoteUser.id,
          remoteUserCollectiveId: req.remoteUser.CollectiveId,
        });
        return collective;
      }
    },
  },
  editPublicMessage: {
    type: new GraphQLList(MemberType),
    description: 'A mutation to edit the public message of all matching members.',
    deprecationReason: '2021-01-27: Please use editPublicMessage from GQLV2',
    args: {
      FromCollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      message: { type: GraphQLString },
    },
    resolve: editPublicMessage,
  },
  createOrder: {
    type: OrderType,
    deprecationReason: '2020-10-13: This endpoint has been moved to GQLV2',
    args: {
      order: {
        type: new GraphQLNonNull(OrderInputType),
      },
    },
    async resolve(_, args, req) {
      const { order } = await createOrder(args.order, req);
      return order;
    },
  },
  confirmOrder: {
    type: OrderType,
    deprecationReason: '2022-11-18: This mutation has been moved to GQLV2',
    args: {
      order: {
        type: new GraphQLNonNull(ConfirmOrderInputType),
      },
    },
    resolve(_, args, req) {
      return confirmOrder(args.order, req.remoteUser);
    },
  },
  refundTransaction: {
    type: TransactionInterfaceType,
    deprecationReason: '2022-01-27: Please use refundTransaction from GQLV2',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    async resolve(_, args, req) {
      return await refundTransaction(_, args, req);
    },
  },
  createApplication: {
    type: ApplicationType,
    args: {
      application: {
        type: new GraphQLNonNull(ApplicationInputType),
      },
    },
    resolve(_, args, req) {
      return applicationMutations.createApplication(_, args, req);
    },
  },
  deleteApplication: {
    type: ApplicationType,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    resolve(_, args, req) {
      return applicationMutations.deleteApplication(_, args, req);
    },
  },
  updatePaymentMethod: {
    type: PaymentMethodType,
    description: 'Update a payment method',
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      name: { type: GraphQLString },
      monthlyLimitPerMember: { type: GraphQLInt },
    },
    resolve: async (_, args, req) => {
      return paymentMethodsMutation.updatePaymentMethod(args, req.remoteUser);
    },
  },
  replaceCreditCard: {
    type: PaymentMethodType,
    description: 'Replace a payment method',
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      name: { type: new GraphQLNonNull(GraphQLString) },
      token: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(StripeCreditCardDataInputType) },
    },
    resolve: async (_, args, req) => {
      return paymentMethodsMutation.replaceCreditCard(args, req.remoteUser);
    },
  },
  createGiftCards: {
    type: new GraphQLList(PaymentMethodType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      PaymentMethodId: { type: GraphQLInt },
      emails: {
        type: new GraphQLList(GraphQLString),
        description: 'A list of emails to generate gift cards for (only if numberOfGiftCards is not provided)',
      },
      numberOfGiftCards: {
        type: GraphQLInt,
        description: 'Number of gift cards to generate (only if emails is not provided)',
      },
      currency: {
        type: GraphQLString,
        description: 'An optional currency. If not provided, will use the collective currency.',
      },
      amount: {
        type: GraphQLInt,
        description: 'The amount as an Integer with cents.',
      },
      batch: {
        type: GraphQLString,
        description: 'Batch name for the created gift cards.',
      },
      monthlyLimitPerMember: { type: GraphQLInt },
      limitedToTags: {
        type: new GraphQLList(GraphQLString),
        description: 'Limit this payment method to make donations to collectives having those tags',
      },
      limitedToHostCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        description: 'Limit this payment method to make donations to the collectives hosted by those hosts',
      },
      limitedToOpenSourceCollectives: {
        type: GraphQLBoolean,
        description: 'Set `limitedToHostCollectiveIds` to open-source collectives only',
      },
      description: {
        type: GraphQLString,
        description: 'A custom message attached to the email that will be sent for this gift card',
      },
      customMessage: {
        type: GraphQLString,
        description: 'A custom message that will be sent in the invitation email',
      },
      expiryDate: { type: GraphQLString },
    },
    resolve: async (_, { emails, numberOfGiftCards, ...args }, { remoteUser }) => {
      if (numberOfGiftCards && emails && numberOfGiftCards !== emails.length) {
        throw Error("numberOfGiftCards and emails counts doesn't match");
      } else if (args.limitedToOpenSourceCollectives && args.limitedToHostCollectiveIds) {
        throw Error('limitedToOpenSourceCollectives and limitedToHostCollectiveIds cannot be used at the same time');
      }

      if (args.limitedToOpenSourceCollectives) {
        const openSourceHost = await models.Collective.findOne({
          attributes: ['id'],
          where: { slug: 'opensource' },
        });
        if (!openSourceHost) {
          throw new Error(
            'Cannot find the host "Open Source Collective". You can disable the opensource-only limitation, or contact us at support@opencollective.com if this keeps happening',
          );
        }
        args.limitedToHostCollectiveIds = [openSourceHost.id];
      }

      if (numberOfGiftCards) {
        return await bulkCreateGiftCards(args, remoteUser, numberOfGiftCards);
      } else if (emails) {
        return await createGiftCardsForEmails(args, remoteUser, emails, args.customMessage);
      }

      throw new Error('You must either pass numberOfGiftCards of an email list');
    },
  },
  claimPaymentMethod: {
    type: PaymentMethodType,
    args: {
      code: { type: new GraphQLNonNull(GraphQLString) },
      user: { type: UserInputType },
    },
    resolve: async (_, args, req) => paymentMethodsMutation.claimPaymentMethod(args, req.remoteUser),
  },
  removePaymentMethod: {
    type: new GraphQLNonNull(PaymentMethodType),
    description: 'Removes the payment method',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the payment method to remove',
      },
    },
    resolve: async (_, args, req) => {
      return paymentMethodsMutation.removePaymentMethod(args.id, req.remoteUser);
    },
  },
  editWebhooks: {
    type: new GraphQLList(NotificationType),
    description: 'Edits (by replacing) the admin-level webhooks for a collective.',
    args: {
      collectiveId: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective whose webhooks are edited.',
      },
      notifications: {
        type: new GraphQLList(NotificationInputType),
        description: 'New notifications for the collective.',
      },
    },
    resolve(_, args, req) {
      return editWebhooks(args, req.remoteUser);
    },
  },
  createWebhook: {
    type: NotificationType,
    description: 'Register user-level webhooks for a collective.',
    args: {
      collectiveSlug: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Slug of the collective the webhook is created for.',
      },
      notification: {
        type: NotificationInputType,
        description: 'The notification object.',
      },
    },
    resolve(_, args, req) {
      return createWebhook(args, req.remoteUser);
    },
  },
  deleteNotification: {
    type: NotificationType,
    description: 'Deletes a notification by ID.',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the notification to delete.',
      },
    },
    resolve(_, args, req) {
      return deleteNotification(args, req.remoteUser);
    },
  },
  backyourstackDispatchOrder: {
    type: new GraphQLObjectType({
      name: 'BackYourStackDispatchState',
      fields: {
        dispatching: { type: GraphQLBoolean },
      },
    }),
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    resolve(_, args) {
      return backyourstackMutations.dispatchOrder(args.id);
    },
  },
  activateCollectiveAsHost: {
    type: CollectiveInterfaceType,
    description: 'Activate a collective as Host.',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective (Organization or User)',
      },
    },
    resolve(_, args, req) {
      return activateCollectiveAsHost(_, args, req);
    },
  },
  deactivateCollectiveAsHost: {
    type: CollectiveInterfaceType,
    description: 'Deactivate a collective as Host.',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective (Organization or User)',
      },
    },
    resolve(_, args, req) {
      return deactivateCollectiveAsHost(_, args, req);
    },
  },
  activateBudget: {
    type: CollectiveInterfaceType,
    description: 'Activate budget (For Host Organizations only)',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the "collective" (Host Organization)',
      },
    },
    resolve(_, args, req) {
      return activateBudget(_, args, req);
    },
  },
  deactivateBudget: {
    type: CollectiveInterfaceType,
    description: 'Deactivate budget (For Host Organizations only)',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the "collective" (Host Organization)',
      },
    },
    resolve(_, args, req) {
      return deactivateBudget(_, args, req);
    },
  },
};

export default mutations;
