// We often use `utils.data` (ie. utils.data('collective1')) in the code to generate test
// data. This approach is enough in certain cases but it has flows:
// - Collectives with unique columns (slugs) cannot be created without resetting the DB
// - No randomness in produced values
//
// This lib is a superset of `utils.data` that generates values that are random and safe
// to use in loops and repeated tests.

import config from 'config';
import { get, kebabCase, padStart, sample } from 'lodash';
import moment from 'moment';
import type { CreateOptions, InferCreationAttributes } from 'sequelize';
import speakeasy from 'speakeasy';
import { v4 as uuid } from 'uuid';

import { activities, channels, roles } from '../../server/constants';
import { types as CollectiveType, types } from '../../server/constants/collectives';
import OAuthScopes from '../../server/constants/oauth-scopes';
import OrderStatuses from '../../server/constants/order_status';
import { PAYMENT_METHOD_SERVICES, PAYMENT_METHOD_TYPES } from '../../server/constants/paymentMethods';
import { REACTION_EMOJI } from '../../server/constants/reaction-emoji';
import MemberRoles from '../../server/constants/roles';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { crypto } from '../../server/lib/encryption';
import { TwoFactorMethod } from '../../server/lib/two-factor-authentication';
import models, {
  Collective,
  ConnectedAccount,
  EmojiReaction,
  ExpenseAttachedFile,
  Location,
  Notification,
  PaypalProduct,
  sequelize,
  Subscription,
  Tier,
  Transaction,
  Update,
  UploadedFile,
  VirtualCard,
} from '../../server/models';
import Application, { ApplicationType } from '../../server/models/Application';
import Comment from '../../server/models/Comment';
import Conversation from '../../server/models/Conversation';
import { HostApplicationStatus } from '../../server/models/HostApplication';
import { LegalDocumentModelInterface } from '../../server/models/LegalDocument';
import { MemberModelInterface } from '../../server/models/Member';
import { MemberInvitationModelInterface } from '../../server/models/MemberInvitation';
import { OrderModelInterface } from '../../server/models/Order';
import { PaymentMethodModelInterface } from '../../server/models/PaymentMethod';
import PayoutMethod, { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import RecurringExpense, { RecurringExpenseIntervals } from '../../server/models/RecurringExpense';
import { AssetType } from '../../server/models/SuspendedAsset';
import {
  SUPPORTED_FILE_EXTENSIONS,
  SUPPORTED_FILE_KINDS,
  SUPPORTED_FILE_TYPES,
} from '../../server/models/UploadedFile';
import User from '../../server/models/User';
import { TokenType } from '../../server/models/UserToken';
import UserTwoFactorMethod from '../../server/models/UserTwoFactorMethod';
import { VirtualCardStatus } from '../../server/models/VirtualCard';
import { randEmail, randUrl } from '../stores';

export { randEmail, sequelize };
export const randStr = (prefix = '') => `${prefix}${uuid().split('-')[0]}`;
export const randNumber = (min = 0, max = 10000000) => Math.floor(Math.random() * max) + min;
export const randAmount = (min = 100, max = 10000000) => randNumber(min, max);
export const multiple = (fn, n, args) => Promise.all([...Array(n).keys()].map(() => fn(args)));
export const fakeOpenCollectiveS3URL = () => `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/${randStr()}`;
export function fakeS3URL(kind, filename = uuid()) {
  return `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/${kebabCase(kind)}/${uuid()}/${filename}`;
}

const randStrOfLength = length =>
  Math.round(Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))
    .toString(36)
    .slice(1);

// For nullable fields, this helper will randomly
const optionally = async (fn, probability = 0.5) => (Math.random() < probability ? fn() : null);

/** Generate an array containing between min and max item, filled with generateFunc */
export const randArray = (generateFunc, min = 1, max = 1) => {
  const arrayLength = randNumber(min, max);
  return [...Array(arrayLength)].map((_, idx) => generateFunc(idx, arrayLength));
};

/**
 * Allows to generate an UUID with the first 8 characters hardcoded. This is useful to generate
 * random but identifiable valid UUIDs.
 */
export const fakeUUID = firstHeightChars => {
  return `${firstHeightChars}-${uuid().substr(9)}`;
};

/**
 * Creates a fake user. All params are optionals.
 */
export const fakeUser = async (
  userData: Record<string, unknown> = {},
  collectiveData: Record<string, unknown> = {},
  { enable2FA = false } = {},
): Promise<User> => {
  const generate2FAAuthToken = () => {
    const twoFactorAuthSecret = speakeasy.generateSecret({ length: 64 });
    return crypto.encrypt(twoFactorAuthSecret.base32).toString();
  };

  const user = await models.User.create({
    email: randEmail(),
    twoFactorAuthToken: enable2FA ? generate2FAAuthToken() : null,
    ...userData,
  });

  if (user.twoFactorAuthToken) {
    await UserTwoFactorMethod.create({
      UserId: user.id,
      method: TwoFactorMethod.TOTP,
      data: { secret: user.twoFactorAuthToken },
    });
  }

  const userCollective = await fakeCollective({
    type: types.USER,
    name: randStr('User Name'),
    slug: randStr('user-'),
    data: { UserId: user.id },
    HostCollectiveId: null,
    CreatedByUserId: user.id,
    ...collectiveData,
    isActive: false,
  });

  await user.update({ CollectiveId: userCollective.id });
  user.collective = userCollective;
  return user;
};

/** Create a fake host */
export const fakeHost = async (hostData: Parameters<typeof fakeCollective>[0] = {}) => {
  return fakeCollective({
    type: CollectiveType.ORGANIZATION,
    name: randStr('Test Host '),
    slug: randStr('host-'),
    HostCollectiveId: null,
    isHostAccount: true,
    ...hostData,
  });
};

/** Create a fake host application */
export const fakeHostApplication = async data => {
  const CollectiveId = data.CollectiveId || (await fakeCollective()).id;
  const HostCollectiveId = data.HostCollectiveId || (await fakeHost()).id;
  return models.HostApplication.create({
    status: HostApplicationStatus.PENDING,
    ...data,
    CollectiveId,
    HostCollectiveId,
  });
};

/**
 * Creates a fake collective. All params are optionals.
 */
export const fakeCollective = async (
  collectiveData: Partial<InferCreationAttributes<Collective>> & {
    admin?: User | { id: number; CreatedByUserId: number };
  } = {},
  sequelizeParams: CreateOptions = {},
) => {
  const type = collectiveData.type || CollectiveType.COLLECTIVE;
  if (!collectiveData.CreatedByUserId) {
    collectiveData.CreatedByUserId = (await fakeUser()).id;
  }
  if (collectiveData.HostCollectiveId === undefined) {
    collectiveData.HostCollectiveId = (await fakeHost()).id;
  }

  const collectiveSequelizeParams = Object.assign({}, sequelizeParams);

  if (collectiveData?.location) {
    collectiveSequelizeParams.include = [{ association: 'location' }];
  }

  const collective = await models.Collective.create(
    {
      type,
      name: collectiveData.isHostAccount ? randStr('Test Host ') : randStr('Test Collective '),
      slug: collectiveData.isHostAccount ? randStr('host-') : randStr('collective-'),
      description: randStr('Description '),
      currency: 'USD',
      twitterHandle: randStr('twitter'),
      website: randUrl(),
      hostFeePercent: 10,
      tags: [randStr(), randStr()],
      isActive: true,
      approvedAt: collectiveData.HostCollectiveId ? new Date() : null,
      ...collectiveData,
    },
    collectiveSequelizeParams,
  );

  collective.host = collective.HostCollectiveId && (await models.Collective.findByPk(collective.HostCollectiveId));
  if (collective.host) {
    try {
      await models.Member.create(
        {
          CollectiveId: collective.id,
          MemberCollectiveId: collective.host.id,
          role: roles.HOST,
          CreatedByUserId: collective.CreatedByUserId,
        },
        sequelizeParams,
      );
    } catch {
      // Ignore if host is already linked
    }
  }
  if (collectiveData.admin) {
    try {
      const admin = collectiveData.admin;
      const isUser = admin instanceof models.User;
      await models.Member.create(
        {
          CollectiveId: collective.id,
          MemberCollectiveId: isUser ? admin.CollectiveId : admin.id,
          role: roles.ADMIN,
          CreatedByUserId: isUser ? admin.id : admin.CreatedByUserId,
        },
        sequelizeParams,
      );
    } catch {
      // Ignore if host is already linked
    }
  }

  return collective;
};

export const fakeOrganization = (organizationData: Record<string, unknown> = {}) => {
  return fakeCollective({
    HostCollectiveId: null,
    name: organizationData.isHostAccount ? randStr('Test Host ') : randStr('Test Organization '),
    slug: organizationData.isHostAccount ? randStr('host-') : randStr('org-'),
    ...organizationData,
    type: types.ORGANIZATION,
  });
};

/**
 * Creates a fake event. All params are optionals.
 */
export const fakeEvent = async (collectiveData: Record<string, unknown> & { ParentCollectiveId?: number } = {}) => {
  const ParentCollectiveId = collectiveData.ParentCollectiveId || (await fakeCollective()).id;
  const parentCollective = await models.Collective.findByPk(ParentCollectiveId);
  return fakeCollective({
    name: randStr('Test Event '),
    slug: randStr('event-'),
    ...collectiveData,
    type: types.EVENT,
    ParentCollectiveId: ParentCollectiveId,
    HostCollectiveId: parentCollective.HostCollectiveId,
  });
};

/**
 * Creates a fake project. All params are optionals.
 */
export const fakeProject = async (collectiveData: Record<string, unknown> & { ParentCollectiveId?: number } = {}) => {
  const ParentCollectiveId = collectiveData.ParentCollectiveId || (await fakeCollective()).id;
  const parentCollective = await models.Collective.findByPk(ParentCollectiveId);
  return fakeCollective({
    name: randStr('Test Project '),
    slug: randStr('project-'),
    ...collectiveData,
    type: types.PROJECT,
    ParentCollectiveId: ParentCollectiveId,
    HostCollectiveId: parentCollective.HostCollectiveId,
  });
};

/**
 * Creates a fake update. All params are optionals.
 */
export const fakeUpdate = async (
  updateData: Partial<InferCreationAttributes<Update>> = {},
  sequelizeParams: CreateOptions = {},
) => {
  const update = await models.Update.create(
    {
      slug: randStr('update-'),
      title: randStr('Update '),
      html: '<div><strong>Hello</strong> Test!</div>',
      ...updateData,
      FromCollectiveId: updateData.FromCollectiveId || (await fakeCollective()).id,
      CollectiveId: updateData.CollectiveId || (await fakeCollective()).id,
      CreatedByUserId: (updateData.CreatedByUserId as number) || (await fakeUser()).id,
    },
    sequelizeParams,
  );

  update.collective = await models.Collective.findByPk(update.CollectiveId);
  update.fromCollective = await models.Collective.findByPk(update.FromCollectiveId);
  return update;
};

/**
 * Creates a fake expense item
 */
export const fakeExpenseItem = async (attachmentData: Record<string, unknown> = {}) => {
  return models.ExpenseItem.create({
    amount: randAmount(),
    url: <string>attachmentData.url || `${randUrl()}.pdf`,
    description: randStr(),
    ...attachmentData,
    ExpenseId: (attachmentData.ExpenseId as number) || (await fakeExpense({ items: [] })).id,
    CreatedByUserId: <number>attachmentData.CreatedByUserId || (await fakeUser()).id,
  });
};

export const fakeExpenseAttachedFile = async (
  attachmentData: Partial<InferCreationAttributes<ExpenseAttachedFile>> = {},
): Promise<ExpenseAttachedFile> => {
  return models.ExpenseAttachedFile.create({
    url: <string>attachmentData.url || `${randUrl()}.pdf`,
    ...attachmentData,
    ExpenseId: (attachmentData.ExpenseId as number) || (await fakeExpense({ items: [] })).id,
    CreatedByUserId: <number>attachmentData.CreatedByUserId || (await fakeUser()).id,
  });
};

export const fakeUploadedFile = async (fileData: Partial<InferCreationAttributes<UploadedFile>> = {}) => {
  const fileType = sample(SUPPORTED_FILE_TYPES);
  const extension = SUPPORTED_FILE_EXTENSIONS[fileType];
  const fileName = `${randStr()}${extension}`;
  const kind = sample(SUPPORTED_FILE_KINDS);
  return models.UploadedFile.create({
    url: fakeS3URL(kind, fileName),
    kind,
    fileSize: randNumber(100, 100000),
    fileName,
    fileType,
    ...fileData,
    CreatedByUserId: <number>fileData.CreatedByUserId || (await fakeUser()).id,
  });
};

/**
 * Fake a Payout Method (defaults to PayPal)
 */
export const fakePayoutMethod = async ({
  data,
  type,
  CollectiveId,
  CreatedByUserId,
  ...props
}: Partial<InferCreationAttributes<PayoutMethod>> = {}) => {
  const generateData = type => {
    if (type === PayoutMethodTypes.PAYPAL) {
      return { email: randEmail(), ...data };
    } else if (type === PayoutMethodTypes.OTHER) {
      return { content: randStr(), ...data };
    } else if (type === PayoutMethodTypes.BANK_ACCOUNT) {
      return {
        accountHolderName: 'Jesse Pinkman',
        currency: 'EUR',
        type: 'iban',
        details: { iban: 'DE1237812738192OK' },
        ...data,
      };
    } else {
      return {};
    }
  };

  type = type || PayoutMethodTypes.PAYPAL;
  return models.PayoutMethod.create({
    name: randStr('Fake Payout Method '),
    data: generateData(type),
    ...props,
    type: type as PayoutMethodTypes,
    CollectiveId: CollectiveId || (await fakeCollective()).id,
    CreatedByUserId: <number>CreatedByUserId || (await fakeUser()).id,
  });
};

/**
 * Creates a fake expense. All params are optionals.
 */
export const fakeExpense = async (expenseData: Record<string, unknown> = {}) => {
  let PayoutMethodId = expenseData.PayoutMethodId as number;
  if (expenseData.legacyPayoutMethod && PayoutMethodId) {
    throw new Error('legacyPayoutMethod and PayoutMethodId are exclusive in fakeExpense');
  } else if (expenseData.legacyPayoutMethod) {
    const pm = await fakePayoutMethod({
      type: models.Expense.getPayoutMethodTypeFromLegacy(<string>expenseData.legacyPayoutMethod),
    });
    PayoutMethodId = pm.id;
  } else if (!PayoutMethodId) {
    PayoutMethodId = (await fakePayoutMethod()).id;
  }

  const payoutMethod = await models.PayoutMethod.findByPk(PayoutMethodId);
  const legacyPayoutMethod = models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod);
  const user = await (expenseData.UserId ? models.User.findByPk(<number>expenseData.UserId) : fakeUser());
  const expense = await models.Expense.create({
    amount: randAmount(),
    currency: 'USD',
    tags: ['Engineering'],
    description: randStr('Test expense '),
    incurredAt: new Date(),
    ...expenseData,
    FromCollectiveId: (expenseData.FromCollectiveId as number) || user.CollectiveId,
    CollectiveId: (expenseData.CollectiveId as number) || (await fakeCollective()).id,
    UserId: user.id,
    lastEditedById: (expenseData.lastEditedById as number) || user.id,
    PayoutMethodId,
    legacyPayoutMethod,
  });

  const items = expenseData?.items as Array<Record<string, unknown>> | undefined;
  if (typeof items === 'undefined') {
    // Helper to generate an attachment. Ensures that items match expense amount
    const generateAttachment = (idx, nbItems) => {
      const baseAmount = Math.floor(expense.amount / nbItems);
      const remainder = expense.amount % nbItems;
      const realAmount = idx !== nbItems - 1 ? baseAmount : baseAmount + remainder;
      return fakeExpenseItem({ ExpenseId: expense.id, amount: realAmount });
    };

    expense.items = await Promise.all(randArray(generateAttachment, 1, 5));
  } else if (items?.every(item => !item.id)) {
    expense.items = await Promise.all(items.map(item => fakeExpenseItem({ ...item, ExpenseId: expense.id })));
  }

  expense.User = await models.User.findByPk(expense.UserId);
  expense.fromCollective = await models.Collective.findByPk(expense.FromCollectiveId);
  expense.collective = await models.Collective.findByPk(expense.CollectiveId, {
    include: [{ association: 'host' }],
  });
  return expense;
};

/**
 * Creates a fake comment. All params are optionals.
 */
export const fakeComment = async (
  commentData: Partial<InferCreationAttributes<Comment>> = {},
  sequelizeParams: CreateOptions = {},
): Promise<Comment> => {
  let FromCollectiveId = get(commentData, 'FromCollectiveId') || get(commentData, 'fromCollective.id');
  let CollectiveId = get(commentData, 'CollectiveId') || get(commentData, 'collective.id');
  let CreatedByUserId = get(commentData, 'CreatedByUserId') || get(commentData, 'createdByUser.id');
  let ExpenseId = get(commentData, 'ExpenseId') || get(commentData, 'expense.id');
  const ConversationId = get(commentData, 'ConversationId') || get(commentData, 'conversation.id');
  if (!FromCollectiveId) {
    FromCollectiveId = (await fakeCollective({}, sequelizeParams)).id;
  }
  if (!CollectiveId) {
    CollectiveId = (await fakeCollective({}, sequelizeParams)).id;
  }
  if (!CreatedByUserId) {
    CreatedByUserId = (await fakeUser()).id;
  }
  if (!ExpenseId && !ConversationId) {
    ExpenseId = (await fakeExpense()).id;
  }

  const comment = await models.Comment.create(
    {
      html: '<div><strong>Hello</strong> Test comment!</div>',
      ...commentData,
      FromCollectiveId: <number>FromCollectiveId,
      CollectiveId: <number>CollectiveId,
      CreatedByUserId: <number>CreatedByUserId,
      ExpenseId: <number>ExpenseId,
      ConversationId: <number>ConversationId,
    },
    sequelizeParams,
  );

  comment.fromCollective = await models.Collective.findByPk(FromCollectiveId);
  comment.collective = await models.Collective.findByPk(CollectiveId);
  return comment;
};

/**
 * Creates a fake comment reaction. All params are optionals.
 */
export const fakeEmojiReaction = async (
  reactionData: Partial<InferCreationAttributes<EmojiReaction>> = {},
  opts: Record<string, unknown> = {},
) => {
  const UserId = <number>reactionData.UserId || (await fakeUser()).id;
  const user = await models.User.findByPk(UserId);
  const FromCollectiveId = reactionData.FromCollectiveId || (await models.Collective.findByPk(user.CollectiveId)).id;
  if (opts.isComment) {
    const ConversationId = (await fakeConversation()).id;
    const CommentId = <number>reactionData.CommentId || (await fakeComment({ ConversationId })).id;
    return models.EmojiReaction.create({
      UserId,
      FromCollectiveId,
      CommentId,
      emoji: sample(REACTION_EMOJI),
      ...reactionData,
    });
  } else {
    const UpdateId = reactionData.UpdateId || (await fakeUpdate()).id;
    return models.EmojiReaction.create({
      UserId,
      FromCollectiveId,
      UpdateId,
      emoji: sample(REACTION_EMOJI),
      ...reactionData,
    });
  }
};

export const fakeConversation = async (
  conversationData: Partial<InferCreationAttributes<Conversation>> = {},
  sequelizeParams: CreateOptions = {},
): Promise<Conversation> => {
  const RootCommentId = <number>conversationData.RootCommentId || (await fakeComment({}, sequelizeParams)).id;
  const rootComment = await models.Comment.findByPk(RootCommentId);
  return models.Conversation.create(
    {
      title: randStr('Update '),
      summary: rootComment.html,
      FromCollectiveId: conversationData.FromCollectiveId || (await fakeCollective()).id,
      CollectiveId: conversationData.CollectiveId || (await fakeCollective()).id,
      CreatedByUserId: <number>conversationData.CreatedByUserId || (await fakeUser()).id,
      RootCommentId: <number>conversationData.RootCommentId || (await fakeComment()).id,
      ...conversationData,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake tier. All params are optionals.
 */
export const fakeTier = async (tierData: Partial<InferCreationAttributes<Tier>> = {}) => {
  const name = randStr('tier');
  const interval = <'month' | 'year'>sample(['month', 'year']);
  const currency = <string>tierData.currency || sample(['USD', 'EUR']);
  const amount = <number>tierData.amount || randAmount(1, 100) * 100;
  const description = `$${amount / 100}/${interval}`;

  return models.Tier.create({
    name,
    type: 'TIER',
    slug: name,
    description,
    amount,
    interval,
    currency,
    maxQuantity: randAmount(),
    ...tierData,
    CollectiveId: tierData.CollectiveId || (await fakeCollective()).id,
  });
};

/**
 * Creates a fake order. All params are optionals.
 */
export const fakeOrder = async (
  orderData: Partial<InferCreationAttributes<OrderModelInterface>> & { subscription?: any } = {},
  { withSubscription = false, withTransactions = false, withBackerMember = false, withTier = false } = {},
) => {
  const CreatedByUserId = orderData.CreatedByUserId || (await fakeUser()).id;
  const user = await models.User.findByPk(<number>CreatedByUserId);
  const FromCollectiveId = orderData.FromCollectiveId || (await models.Collective.findByPk(user.CollectiveId)).id;
  const collective = orderData.CollectiveId
    ? await models.Collective.findByPk(orderData.CollectiveId)
    : await fakeCollective();
  const tier = orderData.TierId
    ? await models.Tier.findByPk(<number>orderData.TierId)
    : withTier
    ? await fakeTier()
    : null;

  const order: OrderModelInterface & {
    subscription?: typeof Subscription;
    transactions?: (typeof Transaction)[];
  } = await models.Order.create({
    quantity: 1,
    currency: collective.currency,
    totalAmount: randAmount(100, 99999999),
    status: withSubscription ? OrderStatuses.ACTIVE : OrderStatuses.PAID,
    ...orderData,
    TierId: tier?.id || null,
    CreatedByUserId,
    FromCollectiveId,
    CollectiveId: collective.id,
  });

  if (order.PaymentMethodId) {
    order.paymentMethod = await models.PaymentMethod.findByPk(order.PaymentMethodId);
  }

  if (withSubscription) {
    const subscriptionData = {
      amount: order.totalAmount,
      interval: order.interval || 'month',
      currency: order.currency,
      isActive: true,
      quantity: order.quantity,
      ...orderData.subscription,
    };

    if (order.paymentMethod?.type === 'subscription' && order.paymentMethod.service === 'paypal') {
      subscriptionData.paypalSubscriptionId = order.paymentMethod.token;
    }

    const subscription = await fakeSubscription(subscriptionData);
    await order.update({ SubscriptionId: subscription.id });
    order.Subscription = subscription;
  }

  if (withTransactions) {
    order.transactions = await Promise.all([
      fakeTransaction({
        OrderId: order.id,
        type: 'CREDIT',
        kind: 'CONTRIBUTION',
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        HostCollectiveId: collective.HostCollectiveId,
        amount: order.totalAmount,
        PaymentMethodId: order.PaymentMethodId,
      }),
      fakeTransaction({
        OrderId: order.id,
        type: 'DEBIT',
        kind: 'CONTRIBUTION',
        CollectiveId: order.FromCollectiveId,
        FromCollectiveId: order.CollectiveId,
        amount: -order.totalAmount,
        PaymentMethodId: order.PaymentMethodId,
      }),
    ]);
  }

  if (withBackerMember) {
    await fakeMember({
      MemberCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      CreatedByUserId: order.CreatedByUserId,
      role: MemberRoles.BACKER,
      TierId: tier?.id || null,
    });
  }

  order.fromCollective = await models.Collective.findByPk(order.FromCollectiveId);
  order.collective = collective;
  order.createdByUser = user;
  order.tier = tier;
  return order;
};

export const fakeSubscription = (params = {}) => {
  return models.Subscription.create({
    amount: randAmount(),
    currency: sample(['USD', 'EUR']),
    interval: sample(['month', 'year']),
    isActive: true,
    quantity: 1,
    ...params,
  });
};

export const fakeNotification = async (data: Partial<InferCreationAttributes<Notification>> = {}) => {
  return models.Notification.create({
    channel: sample(Object.values(channels)),
    type: sample(Object.values(activities)),
    active: true,
    CollectiveId: data.CollectiveId || (await fakeCollective()).id,
    UserId: <number>data.UserId || (await fakeUser()).id,
    webhookUrl: randUrl('example.com/webhooks'),
    ...data,
  });
};

/**
 * Pass `hooks: false` to `sequelizeParams` to prevent triggering a notification.
 */
export const fakeActivity = async (
  data: Record<string, unknown> = {},
  sequelizeParams: Record<string, unknown> = { hooks: false },
) => {
  return models.Activity.create(
    {
      CollectiveId: data.CollectiveId || (await optionally(() => fakeCollective().then(c => c.id))),
      FromCollectiveId: data.FromCollectiveId || (await optionally(() => fakeCollective().then(c => c.id))),
      HostCollectiveId: data.HostCollectiveId || (await optionally(() => fakeHost().then(c => c.id))),
      UserId: <number>data.UserId || (await fakeUser()).id,
      type: sample(Object.values(activities)),
      ...data,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake connectedAccount. All params are optionals.
 */
export const fakeConnectedAccount = async (
  connectedAccountData: Partial<InferCreationAttributes<ConnectedAccount>> = {},
  sequelizeParams: Record<string, unknown> = {},
) => {
  const CollectiveId = connectedAccountData.CollectiveId || (await fakeCollective({}, sequelizeParams)).id;
  const service = sample(['github', 'twitter', 'stripe', 'transferwise']);

  return models.ConnectedAccount.create(
    {
      service,
      ...connectedAccountData,
      CollectiveId,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake transaction. All params are optionals.
 */
export const fakeTransaction = async (
  transactionData: Record<string, unknown> = {},
  { settlementStatus = undefined, createDoubleEntry = false } = {},
) => {
  const amount = (transactionData.amount as number) || randAmount(10, 100) * 100;
  const CreatedByUserId = transactionData.CreatedByUserId || (await fakeUser()).id;
  const FromCollectiveId = transactionData.FromCollectiveId || (await fakeCollective()).id;
  const CollectiveId = transactionData.CollectiveId || (await fakeCollective()).id;
  const createMethod = createDoubleEntry ? 'createDoubleEntry' : 'create';
  const transaction = await models.Transaction[createMethod](
    {
      type: amount < 0 ? 'DEBIT' : 'CREDIT',
      currency: transactionData.currency || 'USD',
      hostCurrency: transactionData.hostCurrency || 'USD',
      hostCurrencyFxRate: 1,
      netAmountInCollectiveCurrency: amount,
      amountInHostCurrency: amount,
      TransactionGroup: uuid(),
      kind: transactionData.ExpenseId ? TransactionKind.EXPENSE : null,
      isDebt: Boolean(settlementStatus),
      hostFeeInHostCurrency: 0,
      platformFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: 0,
      ...transactionData,
      amount,
      CreatedByUserId,
      FromCollectiveId,
      CollectiveId,
    },
    // In the context of tests, we disable hooks because they can conflict with SQL transactions
    // E.g.: afterCreate: transaction => Transaction.createActivity(transaction)
    { hooks: false },
  );

  if (settlementStatus) {
    await models.TransactionSettlement.create({
      TransactionGroup: transaction.TransactionGroup,
      kind: transaction.kind,
      status: settlementStatus,
    });
  }

  return transaction;
};

/**
 * Creates a fake member. All params are optionals.
 */
export const fakeMember = async (data: Partial<InferCreationAttributes<MemberModelInterface>> = {}) => {
  const collective = data.CollectiveId ? await models.Collective.findByPk(data.CollectiveId) : await fakeCollective();
  const memberCollective = data.MemberCollectiveId
    ? await models.Collective.findByPk(data.MemberCollectiveId)
    : await fakeCollective();
  const member = await models.Member.create({
    ...data,
    CollectiveId: collective.id,
    MemberCollectiveId: memberCollective.id,
    role: data.role || roles.ADMIN,
    CreatedByUserId: collective.CreatedByUserId,
  });

  // Attach associations
  member.collective = collective;
  member.memberCollective = memberCollective;
  return member;
};

/**
 * Creates a fake member invitation
 */
export const fakeMemberInvitation = async (
  data: Partial<InferCreationAttributes<MemberInvitationModelInterface>> = {},
) => {
  const collective = data.CollectiveId ? await models.Collective.findByPk(data.CollectiveId) : await fakeCollective();
  const memberCollective = data.MemberCollectiveId
    ? await models.Collective.findByPk(data.MemberCollectiveId)
    : (await fakeUser()).collective;
  const member = await models.MemberInvitation.create({
    ...data,
    CollectiveId: collective.id,
    MemberCollectiveId: memberCollective.id,
    role: data.role || roles.ADMIN,
    CreatedByUserId: collective.CreatedByUserId,
  });

  // Attach associations
  member.collective = collective;
  member.memberCollective = memberCollective;
  return member;
};

const fakePaymentMethodToken = (service, type) => {
  if (service === 'stripe' && type === 'creditcard') {
    return `pm_${randStrOfLength(24)}`;
  } else {
    return randStr();
  }
};

/**
 * Creates a fake Payment Method. All params are optionals.
 */
export const fakePaymentMethod = async (data: Partial<InferCreationAttributes<PaymentMethodModelInterface>>) => {
  const service = data.service || sample(PAYMENT_METHOD_SERVICES);
  const type = data.type || sample(PAYMENT_METHOD_TYPES);
  const token = data.token || fakePaymentMethodToken(service, type);
  return models.PaymentMethod.create({
    ...data,
    type,
    service,
    token,
    CollectiveId: data.CollectiveId || (await fakeCollective().then(c => c.id)),
    currency: data.currency || 'USD',
  });
};

export const fakeLegalDocument = async (data: Partial<InferCreationAttributes<LegalDocumentModelInterface>> = {}) => {
  return models.LegalDocument.create({
    year: new Date().getFullYear(),
    requestStatus: 'REQUESTED',
    ...data,
    CollectiveId: data.CollectiveId || (await fakeCollective().then(c => c.id)),
  });
};

export const fakeLocation = async (data: Partial<InferCreationAttributes<Location>> = {}) => {
  const countries = ['US', 'SE', 'FR', 'BE'];

  return models.Location.create({
    country: sample(countries),
    address: randStr('Formatted Address '),
    structured: {
      address1: randStr('Address1 '),
      address2: randStr('Address2 '),
      city: randStr('City '),
      postalCode: randNumber(10000, 99999).toString(),
      zone: randStr('Zone '),
    },
    ...data,
    CollectiveId: data.CollectiveId || (await fakeCollective().then(c => c.id)),
  });
};

export const fakeCurrencyExchangeRate = async (data: Record<string, unknown> = {}) => {
  const currencies = ['USD', 'NSG', 'EUR', 'CZK', 'JPY', 'MYR', 'AUD'];
  return models.CurrencyExchangeRate.create({
    from: sample(currencies),
    to: sample(currencies),
    rate: randNumber(0, 100) / 100.0,
    ...data,
  });
};

export const fakeVirtualCard = async (virtualCardData: Partial<InferCreationAttributes<VirtualCard>> = {}) => {
  const CollectiveId = virtualCardData.CollectiveId || (await fakeCollective()).id;
  const HostCollectiveId =
    virtualCardData.HostCollectiveId || (await models.Collective.getHostCollectiveId(CollectiveId));

  return models.VirtualCard.create({
    id: uuid(),
    last4: padStart(randNumber(0, 9999).toString(), 4, '0'),
    name: randStr('card'),
    ...virtualCardData,
    data: {
      status: VirtualCardStatus.ACTIVE,
      ...virtualCardData?.data,
    },
    CollectiveId,
    HostCollectiveId,
  });
};

export const fakePaypalProduct = async (data: Partial<InferCreationAttributes<PaypalProduct>> = {}) => {
  const CollectiveId = data.CollectiveId || (await fakeCollective()).id;
  return models.PaypalProduct.create({
    id: randStr('PaypalProduct-'),
    ...data,
    CollectiveId,
  });
};

export const fakePaypalPlan = async (data: Record<string, unknown> = {}) => {
  const product = data.ProductId
    ? await models.PaypalProduct.findByPk(<number>data.ProductId)
    : await fakePaypalProduct(<Record<string, unknown>>data.product || {});

  const collective = await models.Collective.findByPk(product.CollectiveId);
  return models.PaypalPlan.create({
    currency: collective.currency || 'USD',
    interval: sample(['month', 'year']),
    amount: randAmount(),
    id: randStr('PaypalPlan-'),
    ...data,
    ProductId: product.id,
  });
};

export const fakeApplication = async (data: Record<string, unknown> = {}): Promise<any> => {
  let CollectiveId;
  let CreatedByUserId;
  if (data.user) {
    const user = data.user as User;
    CollectiveId = user.CollectiveId;
    CreatedByUserId = user.id;
  } else {
    const user = data.CreatedByUserId ? await models.User.findByPk(<number>data.CreatedByUserId) : await fakeUser();
    CreatedByUserId = user.id;
    CollectiveId = data.CollectiveId || user.CollectiveId;
  }

  const application = await models.Application.create({
    type: <ApplicationType>sample(['apiKey', 'oAuth']),
    apiKey: randStr('ApiKey-'),
    clientId: randStrOfLength(20),
    clientSecret: randStrOfLength(40),
    callbackUrl: randUrl(),
    name: randStr('Name '),
    description: randStr('Description '),
    ...data,
    CollectiveId,
    CreatedByUserId,
  });

  return application.reload({ include: [{ association: 'createdByUser' }, { association: 'collective' }] });
};

export const fakePersonalToken = async (data: Record<string, unknown> = {}) => {
  let CollectiveId;
  let CreatedByUserId;
  if (data.user) {
    const user = data.user as User;
    CollectiveId = user.CollectiveId;
    CreatedByUserId = user.id;
  } else {
    const user = data.CreatedByUserId ? await models.User.findByPk(<number>data.CreatedByUserId) : await fakeUser();
    CreatedByUserId = user.id;
    CollectiveId = data.CollectiveId || user.CollectiveId;
  }

  const personalToken = await models.PersonalToken.create({
    name: randStr('Name '),
    token: randStr('Token-'),
    scope: [OAuthScopes.account, OAuthScopes.transactions],
    CollectiveId,
    UserId: CreatedByUserId,
  });

  return personalToken.reload({ include: [{ association: 'user' }, { association: 'collective' }] });
};

export const fakeUserToken = async (data: Record<string, unknown> = {}) => {
  const user = <User>data.user || (data.UserId ? await models.User.findByPk(<number>data.UserId) : await fakeUser());
  const userToken = await models.UserToken.create({
    type: TokenType.OAUTH,
    accessToken: randStr('Token-'),
    refreshToken: randStr('RefreshToken-'),
    accessTokenExpiresAt: moment().add(60, 'days').toDate(),
    refreshTokenExpiresAt: moment().add(300, 'days').toDate(),
    ...data,
    UserId: user.id,
    ApplicationId: <number>data.ApplicationId || (await fakeApplication({ user })).id,
  });

  // UserToken has a default scope that loads associations (which `.create` does not support)
  return userToken.reload();
};

export const fakeOAuthAuthorizationCode = async (data: Record<string, unknown> = {}) => {
  const user = <User>data.user || (data.UserId ? await models.User.findByPk(<number>data.UserId) : await fakeUser());
  const application =
    <Application>data.application ||
    (data.ApplicationId
      ? await models.Application.findByPk(<number>data.ApplicationId)
      : await fakeApplication({ user }));

  const authorization = await models.OAuthAuthorizationCode.create({
    code: randStr('Code-'),
    expiresAt: moment().add(60, 'days').toDate(),
    redirectUri: application.callbackUrl,
    ...data,
    UserId: user.id,
    ApplicationId: application.id,
  });

  // Bind associations
  authorization.user = user;
  authorization.application = application;

  return authorization;
};

export const fakeRecurringExpense = async (data: Partial<InferCreationAttributes<RecurringExpense>> = {}) => {
  const CollectiveId = data.CollectiveId || (await fakeCollective()).id;
  const FromCollectiveId = data.FromCollectiveId || (await fakeCollective()).id;
  return models.RecurringExpense.create({
    ...data,
    CollectiveId,
    FromCollectiveId,
    interval: <RecurringExpenseIntervals>data.interval || RecurringExpenseIntervals.MONTH,
  });
};

export const fakeSuspendedAsset = async (
  data: { type?: AssetType; fingerprint?: string; reason?: string; [key: string]: unknown } = {},
) => {
  return models.SuspendedAsset.create({
    ...data,
    type: data.type || sample(Object.values(AssetType)),
    fingerprint: data.fingerprint || randStr('asset'),
    reason: data.reason || 'for the sake of this test',
  });
};
