import assert from 'assert';

import type Express from 'express';
import { isNull } from 'lodash';
import moment from 'moment';

import { activities, roles } from '../../constants';
import orderStatus from '../../constants/order-status';
import POLICIES from '../../constants/policies';
import { RefundKind } from '../../constants/refund-kind';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { purgeCacheForCollective } from '../../lib/cache';
import { refundTransaction as refundTransactionPayment } from '../../lib/payments';
import { getPolicy } from '../../lib/policies';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import models, { sequelize } from '../../models';
import Transaction from '../../models/Transaction';
import { Forbidden, NotFound, ValidationFailed } from '../errors';

import { isHostAdmin } from './expenses';
import { canCancelOrder, canRemoveContributorFromOrder, sanitizeMessageForContributor } from './orders';
import { checkScope } from './scope-check';

const getPayee = async (req, transaction) => {
  if (
    (transaction.type === 'CREDIT' && !transaction.isRefund) ||
    (transaction.type === 'DEBIT' && transaction.isRefund)
  ) {
    transaction.collective =
      transaction.collective || (await req.loaders.Collective.byId.load(transaction.CollectiveId));
    return transaction.collective;
  } else {
    transaction.fromCollective =
      transaction.fromCollective || (await req.loaders.Collective.byId.load(transaction.FromCollectiveId));
    return transaction.fromCollective;
  }
};

const getPayer = async (req, transaction) => {
  let column;
  if (transaction.UsingGiftCardFromCollectiveId) {
    // If Transaction was paid with Gift Card, only the card issuer has access to it
    column = 'UsingGiftCardFromCollectiveId';
  } else if (transaction.type === 'CREDIT') {
    column = !transaction.isRefund ? 'FromCollectiveId' : 'CollectiveId';
  } else {
    column = !transaction.isRefund ? 'CollectiveId' : 'FromCollectiveId';
  }

  return req.loaders.Collective.byId.load(transaction[column]);
};

const isRoot = async (req: Express.Request): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  return req.remoteUser.isRoot();
};

const isPayerAccountant = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const payer = await getPayer(req, transaction);
  if (!payer) {
    return false;
  }

  if (req.remoteUser.hasRole(roles.ACCOUNTANT, payer.id)) {
    return true;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, payer.HostCollectiveId)) {
    return true;
  } else if (payer.ParentCollectiveId) {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, payer.ParentCollectiveId);
  } else {
    return false;
  }
};

const isPayeeAccountant = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  const payee = await getPayee(req, transaction);
  return payee?.HostCollectiveId && req.remoteUser.isAdmin(payee.HostCollectiveId);
};

const isPayerCollectiveAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const payer = await getPayer(req, transaction);
  return req.remoteUser.isAdminOfCollective(payer);
};

const isTransactionHostAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser || !transaction.HostCollectiveId) {
    return false;
  } else {
    return req.remoteUser.isAdmin(transaction.HostCollectiveId);
  }
};

const isPayeeCollectiveAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  const payee = await getPayee(req, transaction);
  return req.remoteUser.isAdminOfCollective(payee);
};

/**
 * Returns true if the transaction meets at least one condition.
 * Always returns false for unauthenticated requests.
 */
const remoteUserMeetsOneCondition = async (req, transaction, conditions): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  for (const condition of conditions) {
    if (await condition(req, transaction)) {
      return true;
    }
  }

  return false;
};

/** Checks if the user can refund this transaction */
export const canRefund = async (transaction: Transaction, _: void, req: Express.Request): Promise<boolean> => {
  if (
    transaction.type !== TransactionTypes.CREDIT ||
    transaction.OrderId === null ||
    transaction.isRefund === true ||
    transaction.isDisputed === true
  ) {
    return false;
  }
  if (transaction.OrderId) {
    const order = await req.loaders.Order.byId.load(transaction.OrderId);

    // Not including rejected status since some orders can be rejected without all their transactions being refunded
    if ([orderStatus.REFUNDED].includes(order.status)) {
      return false;
    }
  }

  // Only certain transaction kinds can be refunded
  if (
    ![
      TransactionKind.ADDED_FUNDS,
      TransactionKind.BALANCE_TRANSFER,
      TransactionKind.CONTRIBUTION,
      TransactionKind.EXPENSE,
    ].includes(transaction.kind)
  ) {
    return false;
  }

  // Root users can always refund
  if (await isRoot(req)) {
    return true;
  }

  // Host admins can refund transactions without time limit
  if (await isTransactionHostAdmin(req, transaction)) {
    return true;
  }

  // 1) We only allow the transaction to be refunded by Collective admins if it's within 30 days.
  // 2) To ensure proper accounting, we only allow added funds to be refunded by Host admins and never by Collective admins.
  if (await isPayeeCollectiveAdmin(req, transaction)) {
    const timeLimit = moment().subtract(30, 'd');
    const createdAtMoment = moment(transaction.createdAt);
    const transactionIsOlderThanThirtyDays = createdAtMoment < timeLimit;
    const isManualPayment = transaction.kind === TransactionKind.ADDED_FUNDS || isNull(transaction.PaymentMethodId);
    if (transactionIsOlderThanThirtyDays || isManualPayment) {
      return false;
    }

    // Check host policies
    const payee = await getPayee(req, transaction);
    if (!payee.HostCollectiveId) {
      return false;
    }

    const host = payee.host || (await req.loaders.Collective.byId.load(payee.HostCollectiveId));
    return await getPolicy(host, POLICIES.COLLECTIVE_ADMINS_CAN_REFUND);
  }

  return false;
};

export const canDownloadInvoice = async (transaction: Transaction, _: void, req: Express.Request): Promise<boolean> => {
  if ((req.userToken || req.personalToken) && !checkScope(req, 'transactions')) {
    return false;
  }

  if (transaction.OrderId) {
    const order = await req.loaders.Order.byId.load(transaction.OrderId);
    if (order.status === orderStatus.REJECTED) {
      return false;
    }
  }
  return remoteUserMeetsOneCondition(req, transaction, [
    isPayerCollectiveAdmin,
    isHostAdmin,
    isTransactionHostAdmin,
    isPayerAccountant,
    isPayeeAccountant,
  ]);
};

/** Checks if the user can reject this transaction */
export const canReject = canRefund;

/** Returns the total amount, in cents, that should be refunded from the Collective balance. */
const getRefundableAmountFromCollective = async (transaction: Transaction) => {
  const relatedCreditTransactions = await transaction.getRelatedTransactions({ type: TransactionTypes.CREDIT });
  const contribution = relatedCreditTransactions.find(t =>
    [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS, TransactionKind.BALANCE_TRANSFER].includes(t.kind),
  );
  assert(contribution, 'No contributions found for this transaction');
  const hostFee = relatedCreditTransactions.find(t => t.kind === TransactionKind.HOST_FEE);
  const paymentFee = relatedCreditTransactions.find(t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE);

  return (
    contribution.amountInHostCurrency - (hostFee?.amountInHostCurrency || 0) - (paymentFee?.amountInHostCurrency || 0)
  );
};

export async function refundTransaction(
  passedTransaction: Transaction,
  req: Express.Request,
  refundKind: RefundKind,
  args: { message?: string; ignoreBalanceCheck?: boolean } = {},
) {
  // 0. Retrieve transaction from database
  const transaction = await models.Transaction.findByPk(passedTransaction.id, {
    include: [
      models.Order,
      models.PaymentMethod,
      { association: 'collective', required: false },
      { association: 'fromCollective', required: false },
    ],
  });

  if (!transaction) {
    throw new NotFound('Transaction not found');
  }

  // 1a. Verify user permission using canRefund. User must be either
  //   a. Admin of the collective that received the donation
  //   b. Admin of the Host Collective that received the donation
  //   c. Admin of opencollective.com/opencollective
  // 1b. Check transaction age - only Host admins can refund transactions older than 30 days
  // 1c. The transaction type must be CREDIT to prevent users from refunding their own DEBITs

  const canUserRefund = await canRefund(transaction, undefined, req);
  if (!canUserRefund) {
    throw new Forbidden('Cannot refund this transaction');
  }

  const creditTransaction = transaction.type === 'CREDIT' ? transaction : await transaction.getOppositeTransaction();
  const collective = transaction.type === 'CREDIT' ? transaction.collective : transaction.fromCollective;

  // Check 2FA
  if (collective && req.remoteUser.isAdminOfCollective(collective)) {
    await twoFactorAuthLib.enforceForAccount(req, collective);
  } else {
    if (req.remoteUser.isAdmin(creditTransaction?.HostCollectiveId)) {
      await twoFactorAuthLib.enforceForAccount(
        req,
        await creditTransaction.getHostCollective({ loaders: req.loaders }),
      );
    }
  }

  if (args?.ignoreBalanceCheck) {
    assert(
      req.remoteUser.isAdmin(creditTransaction?.HostCollectiveId),
      'Only Fiscal-Host admins can ignore balance check',
    );
  }
  // Check if the hosted collective has enough funds to refund the transaction
  else {
    const balanceInHostCurrency = await collective.getBalance({ currency: creditTransaction.hostCurrency });
    const refundableAmountFromCollective = await getRefundableAmountFromCollective(creditTransaction);
    if (balanceInHostCurrency < refundableAmountFromCollective) {
      throw new Forbidden('Not enough funds to refund this transaction');
    }
  }

  // 2. Refund via payment method
  // 3. Create new transactions with the refund value in our database
  const result = await refundTransactionPayment(transaction, req.remoteUser, args.message, refundKind, {
    ignoreBalanceCheck: args.ignoreBalanceCheck,
  });

  // Return the transaction passed to the `refundTransaction` method
  // after it was updated.
  return result;
}

type RefundTransactionAsHostArgs = {
  ignoreBalanceCheck?: boolean;
  cancelRecurringContribution?: boolean;
  removeAsContributor?: boolean;
  messageForContributor?: string | null;
};

export async function refundTransactionAsHost(
  passedTransaction: Transaction,
  req: Express.Request,
  args: RefundTransactionAsHostArgs = {},
) {
  const transaction = await models.Transaction.findByPk(passedTransaction.id, {
    include: [
      models.PaymentMethod,
      { association: 'collective', required: false, paranoid: false },
      { association: 'fromCollective', required: false, paranoid: false },
    ],
  });

  if (!transaction) {
    throw new NotFound('Transaction not found');
  }

  // Even though the mutation only routes host admins here, re-check at the
  // function boundary so the host post-actions (CONTRIBUTION_REFUNDED activity,
  // optional cancel/remove) can never run for a non-host caller that reaches
  // this function from somewhere else.
  if (!req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
    throw new Forbidden('Only host admins can use these options on refundTransaction');
  }

  // `canRefund` covers: CREDIT, OrderId !== null, not already refunded/disputed,
  // refundable kind, parent order not REFUNDED, and that the user has permission.
  // The inner `refundTransaction` call below also runs `canRefund`, but checking
  // here lets us fail fast with a clear error before loading the order.
  if (!(await canRefund(transaction, undefined, req))) {
    throw new Forbidden('Cannot refund this transaction');
  }

  const order = await models.Order.findByPk(transaction.OrderId, {
    include: [
      { model: models.Subscription },
      { model: models.Collective, as: 'collective', paranoid: false },
      { model: models.Collective, as: 'fromCollective', paranoid: false },
    ],
  });

  if (!order) {
    // Defensive: canRefund guarantees a non-null OrderId, but the row could
    // theoretically have been hard-deleted between the two queries.
    throw new NotFound('Order not found');
  }

  if (args.cancelRecurringContribution && !order.SubscriptionId) {
    throw new ValidationFailed('Only recurring contributions can be cancelled');
  } else if (
    args.cancelRecurringContribution &&
    order.status === orderStatus.CANCELLED &&
    !order.Subscription?.isActive
  ) {
    throw new ValidationFailed('Recurring contribution already canceled');
  }

  // Enforce the same permission booleans exposed on the order for the optional
  // sub-actions. The refund itself is permission-checked per transaction by
  // `canRefund` above.
  if (args.cancelRecurringContribution && !(await canCancelOrder(req, order))) {
    throw new Forbidden('Cannot cancel this recurring contribution as a host admin');
  }
  if (args.removeAsContributor && !(await canRemoveContributorFromOrder(req, order))) {
    throw new Forbidden("You don't have permission to remove this contributor from the collective");
  }

  const messageForContributor = sanitizeMessageForContributor(args.messageForContributor);
  const host = transaction.HostCollectiveId
    ? await req.loaders.Collective.byId.load(transaction.HostCollectiveId)
    : null;

  const previousStatus = order.status;

  // Issue the refund first so we don't end up cancelling the order / removing the
  // contributor when the payment processor refund itself fails. `refundTransaction`
  // also enforces 2FA on the host, so no separate check is needed here.
  const refundedTransaction = await refundTransaction(transaction, req, RefundKind.REFUND, {
    ignoreBalanceCheck: args.ignoreBalanceCheck,
    message: messageForContributor ?? undefined,
  });

  // The CONTRIBUTION_REFUNDED activity sends the single user-facing email for the
  // whole refund flow (see `server/lib/notifications/email.ts`). The follow-up
  // SUBSCRIPTION_CANCELED and CONTRIBUTOR_REMOVED_BY_HOST activities are recorded
  // for the timeline / webhooks; SUBSCRIPTION_CANCELED suppresses its own email
  // via `hostAction.refund`, and CONTRIBUTOR_REMOVED_BY_HOST has no email template.
  const refundFlowHostAction = {
    cancel: Boolean(args.cancelRecurringContribution),
    refund: true,
    removeAsContributor: Boolean(args.removeAsContributor),
  };

  await sequelize.transaction(async dbTransaction => {
    if (args.cancelRecurringContribution) {
      await order.update(
        { status: orderStatus.CANCELLED, data: { ...order.data, previousStatus } },
        { transaction: dbTransaction },
      );
    }

    if (args.removeAsContributor) {
      await models.Member.destroy({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: roles.BACKER,
        },
        transaction: dbTransaction,
      });
    }

    await models.Activity.create(
      {
        type: activities.CONTRIBUTION_REFUNDED,
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        HostCollectiveId: order.collective.HostCollectiveId,
        OrderId: order.id,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        data: {
          collective: order.collective.minimal,
          host: host?.minimal,
          user: req.remoteUser.minimal,
          fromCollective: order.fromCollective.minimal,
          order: order.info,
          refundCount: 1,
          refundedTransactionIds: [refundedTransaction.id],
          messageForContributors: messageForContributor,
          messageSource: 'HOST',
          hostAction: refundFlowHostAction,
        },
      },
      { transaction: dbTransaction },
    );

    if (args.cancelRecurringContribution) {
      await models.Activity.create(
        {
          type: activities.SUBSCRIPTION_CANCELED,
          CollectiveId: order.CollectiveId,
          FromCollectiveId: order.FromCollectiveId,
          HostCollectiveId: order.collective.HostCollectiveId,
          OrderId: order.id,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          data: {
            subscription: order.Subscription,
            collective: order.collective.minimal,
            host: host?.minimal,
            user: req.remoteUser.minimal,
            fromCollective: order.fromCollective.minimal,
            order: order.info,
            previousStatus,
            messageForContributors: messageForContributor,
            messageSource: 'HOST',
            hostAction: refundFlowHostAction,
          },
        },
        { transaction: dbTransaction },
      );
    }

    if (args.removeAsContributor) {
      await models.Activity.create(
        {
          type: activities.CONTRIBUTOR_REMOVED_BY_HOST,
          CollectiveId: order.CollectiveId,
          FromCollectiveId: order.FromCollectiveId,
          HostCollectiveId: order.collective.HostCollectiveId,
          OrderId: order.id,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          data: {
            collective: order.collective.minimal,
            host: host?.minimal,
            user: req.remoteUser.minimal,
            fromCollective: order.fromCollective.minimal,
            order: order.info,
            messageForContributors: messageForContributor,
            messageSource: 'HOST',
            hostAction: refundFlowHostAction,
          },
        },
        { transaction: dbTransaction },
      );
    }
  });

  // `Subscription.deactivate` doesn't accept a transaction and performs an external
  // PayPal call, so it's run after the DB transaction commits to avoid stranding a
  // deactivated subscription on a rolled-back order.
  if (args.cancelRecurringContribution && order.Subscription?.isActive) {
    await order.Subscription.deactivate('Cancelled by host admin', host);
  }

  purgeCacheForCollective(order.fromCollective.slug);
  purgeCacheForCollective(order.collective.slug);

  return refundedTransaction;
}
