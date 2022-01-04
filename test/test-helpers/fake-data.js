// We often use `utils.data` (ie. utils.data('collective1')) in the code to generate test
// data. This approach is enough in certain cases but it has flows:
// - Collectives with unique columns (slugs) cannot be created without resetting the DB
// - No randomness in produced values
//
// This lib is a superset of `utils.data` that generates values that are random and safe
// to use in loops and repeated tests.

import { get, padStart, sample } from 'lodash';
import { v4 as uuid } from 'uuid';

import { activities, channels, roles } from '../../server/constants';
import { types as CollectiveType } from '../../server/constants/collectives';
import { PAYMENT_METHOD_SERVICES, PAYMENT_METHOD_TYPES } from '../../server/constants/paymentMethods';
import { REACTION_EMOJI } from '../../server/constants/reaction-emoji';
import { TransactionKind } from '../../server/constants/transaction-kind';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { randEmail, randUrl } from '../stores';

export const randStr = (prefix = '') => `${prefix}${uuid().split('-')[0]}`;
export const randNumber = (min = 0, max = 10000000) => Math.floor(Math.random() * max) + min;
export const randAmount = (min = 100, max = 10000000) => randNumber(min, max);
export const multiple = (fn, n, args) => Promise.all([...Array(n).keys()].map(() => fn(args)));

const randStrOfLength = length =>
  Math.round(Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))
    .toString(36)
    .slice(1);

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
export const fakeUser = async (userData, collectiveData) => {
  const user = await models.User.create({
    email: randEmail(),
    firstName: randStr('FirstName '),
    lastName: randStr('LastName '),
    ...userData,
  });

  const userCollective = await fakeCollective({
    type: 'USER',
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
export const fakeHost = async hostData => {
  return fakeCollective({
    type: CollectiveType.ORGANIZATION,
    name: randStr('Test Host '),
    slug: randStr('host-'),
    HostCollectiveId: null,
    isHostAccount: true,
    ...hostData,
  });
};

/**
 * Creates a fake collective. All params are optionals.
 */
export const fakeCollective = async (collectiveData = {}, sequelizeParams = {}) => {
  const type = collectiveData.type || CollectiveType.COLLECTIVE;
  if (!collectiveData.CreatedByUserId) {
    collectiveData.CreatedByUserId = (await fakeUser()).id;
  }
  if (collectiveData.HostCollectiveId === undefined) {
    collectiveData.HostCollectiveId = (await fakeHost()).id;
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
    sequelizeParams,
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
      const isUser = collectiveData.admin instanceof models.User;
      await models.Member.create(
        {
          CollectiveId: collective.id,
          MemberCollectiveId: isUser ? collectiveData.admin.CollectiveId : collectiveData.admin.id,
          role: roles.ADMIN,
          CreatedByUserId: isUser ? collectiveData.admin.id : collectiveData.admin.CreatedByUserId,
        },
        sequelizeParams,
      );
    } catch {
      // Ignore if host is already linked
    }
  }

  return collective;
};

export const fakeOrganization = (organizationData = {}) => {
  return fakeCollective({
    HostCollectiveId: null,
    name: organizationData.isHostAccount ? randStr('Test Host ') : randStr('Test Organization '),
    slug: organizationData.isHostAccount ? randStr('host-') : randStr('org-'),
    ...organizationData,
    type: 'ORGANIZATION',
  });
};

/**
 * Creates a fake event. All params are optionals.
 */
export const fakeEvent = async (collectiveData = {}) => {
  const ParentCollectiveId = collectiveData.ParentCollectiveId || (await fakeCollective()).id;
  const parentCollective = await models.Collective.findByPk(ParentCollectiveId);
  return fakeCollective({
    name: randStr('Test Event '),
    slug: randStr('event-'),
    ...collectiveData,
    type: 'EVENT',
    ParentCollectiveId: ParentCollectiveId,
    HostCollectiveId: parentCollective.HostCollectiveId,
  });
};

/**
 * Creates a fake project. All params are optionals.
 */
export const fakeProject = async (collectiveData = {}) => {
  const ParentCollectiveId = collectiveData.ParentCollectiveId || (await fakeCollective()).id;
  const parentCollective = await models.Collective.findByPk(ParentCollectiveId);
  return fakeCollective({
    name: randStr('Test Project '),
    slug: randStr('project-'),
    ...collectiveData,
    type: 'PROJECT',
    ParentCollectiveId: ParentCollectiveId,
    HostCollectiveId: parentCollective.HostCollectiveId,
  });
};

/**
 * Creates a fake update. All params are optionals.
 */
export const fakeUpdate = async (updateData = {}, sequelizeParams = {}) => {
  const update = await models.Update.create(
    {
      slug: randStr('update-'),
      title: randStr('Update '),
      html: '<div><strong>Hello</strong> Test!</div>',
      ...updateData,
      FromCollectiveId: updateData.FromCollectiveId || (await fakeCollective()).id,
      CollectiveId: updateData.CollectiveId || (await fakeCollective()).id,
      CreatedByUserId: updateData.CreatedByUserId || (await fakeUser()).id,
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
export const fakeExpenseItem = async (attachmentData = {}) => {
  return models.ExpenseItem.create({
    amount: randAmount(),
    url: `${randUrl()}.pdf`,
    description: randStr(),
    ...attachmentData,
    ExpenseId: attachmentData.ExpenseId || (await fakeExpense({ items: [] })).id,
    CreatedByUserId: attachmentData.CreatedByUserId || (await fakeUser()).id,
  });
};

/**
 * Fake a Payout Method (defaults to PayPal)
 */
export const fakePayoutMethod = async (data = {}) => {
  const generateData = type => {
    if (type === PayoutMethodTypes.PAYPAL) {
      return { email: randEmail() };
    } else if (type === PayoutMethodTypes.OTHER) {
      return { content: randStr() };
    } else if (type === PayoutMethodTypes.BANK_ACCOUNT) {
      return {
        accountHolderName: 'Jesse Pinkman',
        currency: 'EUR',
        type: 'iban',
        details: { iban: 'DE1237812738192OK' },
      };
    } else {
      return {};
    }
  };

  const type = (data && data.type) || PayoutMethodTypes.PAYPAL;
  return models.PayoutMethod.create({
    name: randStr('Fake Payout Method '),
    data: generateData(type),
    ...data,
    type,
    CollectiveId: data.CollectiveId || (await fakeCollective()).id,
    CreatedByUserId: data.CreatedByUserId || (await fakeUser()).id,
  });
};

/**
 * Creates a fake expense. All params are optionals.
 */
export const fakeExpense = async (expenseData = {}) => {
  let PayoutMethodId = expenseData.PayoutMethodId;
  if (expenseData.legacyPayoutMethod && PayoutMethodId) {
    throw new Error('legacyPayoutMethod and PayoutMethodId are exclusive in fakeExpense');
  } else if (expenseData.legacyPayoutMethod) {
    const pm = await fakePayoutMethod({
      type: models.Expense.getPayoutMethodTypeFromLegacy(expenseData.legacyPayoutMethod),
    });
    PayoutMethodId = pm.id;
  } else if (!PayoutMethodId) {
    PayoutMethodId = (await fakePayoutMethod()).id;
  }

  const payoutMethod = await models.PayoutMethod.findByPk(PayoutMethodId);
  const legacyPayoutMethod = models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod);
  const user = await (expenseData.UserId ? models.User.findByPk(expenseData.UserId) : fakeUser());
  const expense = await models.Expense.create({
    amount: randAmount(),
    currency: 'USD',
    tags: ['Engineering'],
    description: randStr('Test expense '),
    incurredAt: new Date(),
    ...expenseData,
    FromCollectiveId: expenseData.FromCollectiveId || user.CollectiveId,
    CollectiveId: expenseData.CollectiveId || (await fakeCollective()).id,
    UserId: user.id,
    lastEditedById: expenseData.lastEditedById || user.id,
    PayoutMethodId,
    legacyPayoutMethod,
  });

  if (!expenseData || typeof expenseData.items === 'undefined') {
    // Helper to generate an attachment. Ensures that items match expense amount
    const generateAttachment = (idx, nbItems) => {
      const baseAmount = Math.floor(expense.amount / nbItems);
      const remainder = expense.amount % nbItems;
      const realAmount = idx !== nbItems - 1 ? baseAmount : baseAmount + remainder;
      return fakeExpenseItem({ ExpenseId: expense.id, amount: realAmount });
    };

    expense.items = await Promise.all(randArray(generateAttachment, 1, 5));
  }

  expense.User = await models.User.findByPk(expense.UserId);
  return expense;
};

/**
 * Creates a fake comment. All params are optionals.
 */
export const fakeComment = async (commentData = {}, sequelizeParams = {}) => {
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

  return models.Comment.create(
    {
      html: '<div><strong>Hello</strong> Test comment!</div>',
      ...commentData,
      FromCollectiveId,
      CollectiveId,
      CreatedByUserId,
      ExpenseId,
      ConversationId,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake comment reaction. All params are optionals.
 */
export const fakeEmojiReaction = async (reactionData = {}, opts = {}) => {
  const UserId = reactionData.UserId || (await fakeUser()).id;
  const user = await models.User.findByPk(UserId);
  const FromCollectiveId = reactionData.FromCollectiveId || (await models.Collective.findByPk(user.CollectiveId)).id;
  if (opts.isComment) {
    const ConversationId = (await fakeConversation()).id;
    const CommentId = reactionData.CommentId || (await fakeComment({ ConversationId })).id;
    return models.EmojiReaction.create({
      UserId,
      FromCollectiveId,
      CommentId,
      emoji: sample(REACTION_EMOJI),
    });
  } else {
    const CollectiveId = (await fakeCollective()).id;
    const UpdateId = reactionData.UpdateId || (await fakeUpdate({ CollectiveId })).id;
    return models.EmojiReaction.create({
      UserId,
      FromCollectiveId,
      UpdateId,
      emoji: sample(REACTION_EMOJI),
    });
  }
};

export const fakeConversation = async (conversationData = {}, sequelizeParams) => {
  const RootCommentId = conversationData.RootCommentId || (await fakeComment({}, sequelizeParams)).id;
  const rootComment = await models.Comment.findByPk(RootCommentId);
  return models.Conversation.create(
    {
      title: randStr('Update '),
      summary: rootComment.html,
      FromCollectiveId: conversationData.FromCollectiveId || (await fakeCollective()).id,
      CollectiveId: conversationData.CollectiveId || (await fakeCollective()).id,
      CreatedByUserId: conversationData.CreatedByUserId || (await fakeUser()).id,
      RootCommentId: conversationData.RootCommentId || (await fakeComment()).id,
      ...conversationData,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake tier. All params are optionals.
 */
export const fakeTier = async (tierData = {}) => {
  const name = randStr('tier');
  const interval = sample(['month', 'year']);
  const currency = tierData.currency || sample(['USD', 'EUR']);
  const amount = tierData.amount || randAmount(1, 100) * 100;
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
  });
};

/**
 * Creates a fake order. All params are optionals.
 */
export const fakeOrder = async (orderData = {}, { withSubscription = false, withTransactions = false } = {}) => {
  const CreatedByUserId = orderData.CreatedByUserId || (await fakeUser()).id;
  const user = await models.User.findByPk(CreatedByUserId);
  const FromCollectiveId = orderData.FromCollectiveId || (await models.Collective.findByPk(user.CollectiveId)).id;
  const CollectiveId = orderData.CollectiveId || (await fakeCollective()).id;
  const collective = await models.Collective.findByPk(CollectiveId);

  const order = await models.Order.create({
    quantity: 1,
    currency: collective.currency,
    totalAmount: randAmount(100, 99999999),
    ...orderData,
    CreatedByUserId,
    FromCollectiveId,
    CollectiveId,
  });

  if (order.PaymentMethodId) {
    order.paymentMethod = await models.PaymentMethod.findByPk(order.PaymentMethodId);
  }

  if (withSubscription) {
    const subscription = await fakeSubscription({
      amount: order.totalAmount,
      interval: 'month',
      currency: order.currency,
      isActive: true,
      quantity: order.quantity,
      ...orderData.subscription,
    });
    await order.update({ SubscriptionId: subscription.id });
    order.Subscription = subscription;
  }

  if (withTransactions) {
    order.transactions = await Promise.all([
      fakeTransaction({
        OrderId: order.id,
        type: 'CREDIT',
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        amount: order.amount,
      }),
      fakeTransaction({
        OrderId: order.id,
        type: 'DEBIT',
        CollectiveId: order.FromCollectiveId,
        FromCollectiveId: order.CollectiveId,
        amount: -order.amount,
      }),
    ]);
  }

  order.fromCollective = await models.Collective.findByPk(order.FromCollectiveId);
  order.collective = collective;
  order.createdByUser = user;
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

export const fakeNotification = async (data = {}) => {
  return models.Notification.create({
    channel: sample(Object.values(channels)),
    type: sample(Object.values(activities)),
    active: true,
    CollectiveId: data.CollectiveId || (await fakeCollective()).id,
    UserId: data.UserId || (await fakeUser()).id,
    webhookUrl: randUrl('test.opencollective.com/webhooks'),
    ...data,
  });
};

/**
 * Pass `hooks: false` to `sequelizeParams` to prevent triggering a notification.
 */
export const fakeActivity = async (data = {}, sequelizeParams) => {
  return models.Activity.create(
    {
      CollectiveId: data.CollectiveId || (await fakeCollective()).id,
      UserId: data.UserId || (await fakeUser()).id,
      type: sample(Object.values(activities)),
      ...data,
    },
    sequelizeParams,
  );
};

/**
 * Creates a fake connectedAccount. All params are optionals.
 */
export const fakeConnectedAccount = async (connectedAccountData = {}, sequelizeParams = {}) => {
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
  transactionData = {},
  { settlementStatus = undefined, createDoubleEntry = false } = {},
) => {
  const amount = transactionData.amount || randAmount(10, 100) * 100;
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
export const fakeMember = async (data = {}) => {
  const collective = data.CollectiveId ? await models.Collective.findByPk(data.CollectiveId) : await fakeCollective();
  const memberCollective = data.MemberCollectiveId
    ? await models.Collective.findByPk(data.MemberCollectiveId)
    : await fakeCollective();
  const member = await models.Member.create({
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
export const fakePaymentMethod = async data => {
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

export const fakeLegalDocument = async (data = {}) => {
  return models.LegalDocument.create({
    year: new Date().getFullYear(),
    requestStatus: 'REQUESTED',
    ...data,
    CollectiveId: data.CollectiveId || (await fakeCollective().then(c => c.id)),
  });
};

export const fakeCurrencyExchangeRate = async (data = {}) => {
  const currencies = ['USD', 'NSG', 'EUR', 'CZK', 'JPY', 'MYR', 'AUD'];
  const rate = await models.CurrencyExchangeRate.create({
    from: sample(currencies),
    to: sample(currencies),
    rate: randNumber(0, 100) / 100.0,
    ...data,
  });

  if (data.insertedAt) {
    rate.createdAt = data.insertedAt;
    rate.changed('createdAt', true);
    return rate.save();
  } else {
    return rate;
  }
};

export const fakeVirtualCard = async (virtualCardData = {}) => {
  const CollectiveId = virtualCardData.CollectiveId || (await fakeCollective()).id;
  const HostCollectiveId =
    virtualCardData.HostCollectiveId || (await models.Collective.getHostCollectiveId(CollectiveId));

  return models.VirtualCard.create({
    id: uuid(),
    last4: padStart(randNumber(0, 9999).toString(), 4, '0'),
    name: randStr('card'),
    ...virtualCardData,
    CollectiveId,
    HostCollectiveId,
  });
};

export const fakePaypalProduct = async (data = {}) => {
  const CollectiveId = data.CollectiveId || (await fakeCollective()).id;
  return models.PaypalProduct.create({
    id: randStr('PaypalProduct-'),
    ...data,
    CollectiveId,
  });
};

export const fakePaypalPlan = async (data = {}) => {
  const product = data.ProductId
    ? await models.PaypalProduct.findByPk(data.ProductId)
    : await fakePaypalProduct(data.product || {});

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

export const fakeApplication = async (data = {}) => {
  const CollectiveId = data.CollectiveId || (await fakeCollective()).id;
  return models.Application.create({
    type: sample(['apiKey', 'oAuth']),
    apiKey: randStr('ApiKey-'),
    clientId: randStr('Client-'),
    clientSecret: randStr('Secret-'),
    callbackUrl: randUrl(),
    name: randStr('Name '),
    description: randStr('Description '),
    ...data,
    CollectiveId,
  });
};
