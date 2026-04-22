import type Express from 'express';
import { get, uniq } from 'lodash';

import { activities } from '../../constants';
import OrderStatuses from '../../constants/order-status';
import { RefundKind } from '../../constants/refund-kind';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { purgeCacheForCollective } from '../../lib/cache';
import logger from '../../lib/logger';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../../lib/sanitize-html';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import models, { sequelize } from '../../models';
import Order from '../../models/Order';
import Transaction from '../../models/Transaction';
import { ValidationFailed } from '../errors';

import { isOrderHostAdmin } from './orders';
import { refundTransaction } from './transactions';

/** Stable error codes returned via ManageOrderRefundError.code. */
export enum ManageOrderRefundErrorCode {
  ALREADY_REFUNDED = 'ALREADY_REFUNDED',
  CHARGED_BACK = 'CHARGED_BACK',
  STRIPE_REFUND_WINDOW_EXPIRED = 'STRIPE_REFUND_WINDOW_EXPIRED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  PAYMENT_PROVIDER_UNSUPPORTED = 'PAYMENT_PROVIDER_UNSUPPORTED',
  UNKNOWN = 'UNKNOWN',
}

const MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH = 2000;

export type ManageOrderRefundError = {
  transaction: Transaction;
  message: string;
  code: ManageOrderRefundErrorCode;
};

export type ManageOrderResult = {
  order: Order;
  refundedTransactions: Transaction[];
  refundErrors: ManageOrderRefundError[];
};

export type ManageOrderArgs = {
  cancel: boolean;
  refundTransactions: Transaction[] | null;
  removeAsContributor: boolean;
  messageForContributor?: string | null;
};

/** Categorize a refund error coming back from `refundTransaction` into a stable code. */
const classifyRefundError = (error: Error | unknown): ManageOrderRefundErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  const stripeCode = get(error, 'raw.code') as string | undefined;

  if (stripeCode === 'charge_already_refunded' || /already been refunded/i.test(message)) {
    return ManageOrderRefundErrorCode.ALREADY_REFUNDED;
  }
  if (/charged back/i.test(message)) {
    return ManageOrderRefundErrorCode.CHARGED_BACK;
  }
  if (stripeCode === 'charge_disputed' || /past the refund window|refund_window|refund is not allowed/i.test(message)) {
    return ManageOrderRefundErrorCode.STRIPE_REFUND_WINDOW_EXPIRED;
  }
  if (/not enough funds|insufficient/i.test(message)) {
    return ManageOrderRefundErrorCode.INSUFFICIENT_FUNDS;
  }
  if (/does not support refunds/i.test(message)) {
    return ManageOrderRefundErrorCode.PAYMENT_PROVIDER_UNSUPPORTED;
  }
  return ManageOrderRefundErrorCode.UNKNOWN;
};

const REFUNDABLE_KINDS = [TransactionKind.ADDED_FUNDS, TransactionKind.BALANCE_TRANSFER, TransactionKind.CONTRIBUTION];

/**
 * Validate a batch of transaction references for a refund request against an order:
 * they must all be CREDIT, belong to this order, and not already refunded/disputed.
 * Throws ValidationFailed if any don't match.
 */
const validateRefundTransactions = (order: Order, transactions: Transaction[]): void => {
  const seen = new Set<number>();
  for (const tx of transactions) {
    if (!tx) {
      throw new ValidationFailed('One or more transactions to refund could not be found');
    }
    if (seen.has(tx.id)) {
      throw new ValidationFailed(`Transaction ${tx.id} was listed multiple times`);
    }
    seen.add(tx.id);
    if (tx.OrderId !== order.id) {
      throw new ValidationFailed(`Transaction ${tx.id} does not belong to this order`);
    }
    if (tx.type !== TransactionTypes.CREDIT) {
      throw new ValidationFailed(`Transaction ${tx.id} is not a CREDIT transaction and cannot be refunded`);
    }
    if (tx.RefundTransactionId || tx.isRefund) {
      throw new ValidationFailed(`Transaction ${tx.id} has already been refunded`);
    }
    if (tx.isDisputed) {
      throw new ValidationFailed(`Transaction ${tx.id} is disputed and cannot be refunded`);
    }
    if (!REFUNDABLE_KINDS.includes(tx.kind)) {
      throw new ValidationFailed(`Transaction ${tx.id} is not of a refundable kind`);
    }
  }
};

/**
 * Host-admin entry point to cancel an order, refund selected transactions and/or
 * remove the contributor from the collective's public profile. See the
 * `manageOrder` GraphQL mutation for the API shape.
 *
 * Hard failures (auth, validation, DB failures for cancel/remove) roll back.
 * Per-transaction refund errors are soft and returned in `refundErrors` so that
 * other side-effects still commit.
 */
export async function manageOrderAsHost(
  order: Order,
  args: ManageOrderArgs,
  req: Express.Request,
): Promise<ManageOrderResult> {
  if (!(await isOrderHostAdmin(req, order))) {
    throw new Error("You don't have permission to manage this contribution");
  }

  const { cancel, refundTransactions, removeAsContributor } = args;
  if (!cancel && !removeAsContributor && (!refundTransactions || refundTransactions.length === 0)) {
    throw new ValidationFailed('You must request at least one of: cancel, refund, or removeAsContributor');
  }

  if (cancel && !order.SubscriptionId) {
    throw new ValidationFailed('Only recurring contributions can be cancelled');
  }

  if (cancel && order.status === OrderStatuses.CANCELLED && !order.Subscription?.isActive) {
    throw new ValidationFailed('Recurring contribution already canceled');
  }

  if (refundTransactions?.length) {
    validateRefundTransactions(order, refundTransactions);
  }

  // Sanitize messageForContributor: limit length + strip HTML to keep emails safe.
  let messageForContributor: string | null = null;
  if (args.messageForContributor) {
    const sanitized = sanitizeHTML(args.messageForContributor, optsSanitizeHtmlForSimplified).trim();
    if (sanitized.length > MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH) {
      throw new ValidationFailed(
        `messageForContributor must be at most ${MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH} characters`,
      );
    }
    messageForContributor = sanitized.length ? sanitized : null;
  }

  const toAccount = order.collective || (await req.loaders.Collective.byId.load(order.CollectiveId));
  const fromAccount = order.fromCollective || (await req.loaders.Collective.byId.load(order.FromCollectiveId));
  const hostCollectiveId = toAccount.HostCollectiveId;
  const host = hostCollectiveId ? await req.loaders.Collective.byId.load(hostCollectiveId) : null;

  // Enforce 2FA against the host account (we already know the user is a host admin).
  if (host) {
    await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
  }

  const refundedTransactions: Transaction[] = [];
  const refundErrors: ManageOrderRefundError[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activitiesToCreate: Record<string, any>[] = [];

  // Run cancel + remove-as-contributor in a DB transaction so they're atomic.
  // Refunds touch external payment providers and are handled outside the
  // transaction with per-tx error collection.
  await sequelize.transaction(async dbTransaction => {
    if (cancel) {
      const previousStatus = order.status;
      await order.update(
        { status: OrderStatuses.CANCELLED, data: { ...order.data, previousStatus } },
        { transaction: dbTransaction },
      );
      if (order.Subscription?.isActive) {
        // NOTE: Subscription.deactivate doesn't accept a sequelize transaction param
        // today; if deactivate fails after commit the Activity will still be created
        // but we'll leave the order as CANCELLED.
        await order.Subscription.deactivate('Cancelled by host admin', host);
      }

      activitiesToCreate.push({
        type: activities.SUBSCRIPTION_CANCELED_BY_HOST,
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        HostCollectiveId: hostCollectiveId,
        OrderId: order.id,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        data: {
          subscription: order.Subscription,
          collective: toAccount.minimal,
          host: host?.minimal,
          user: req.remoteUser.minimal,
          fromCollective: fromAccount.minimal,
          order: order.info,
          previousStatus,
          messageForContributor,
          messageSource: 'HOST',
          hostAction: { cancel, refund: Boolean(refundTransactions?.length), removeAsContributor },
        },
      });
    }

    if (removeAsContributor) {
      await models.Member.destroy({
        where: {
          MemberCollectiveId: fromAccount.id,
          CollectiveId: toAccount.id,
          role: 'BACKER',
        },
        transaction: dbTransaction,
      });
      activitiesToCreate.push({
        type: activities.CONTRIBUTOR_REMOVED_BY_HOST,
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        HostCollectiveId: hostCollectiveId,
        OrderId: order.id,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        data: {
          collective: toAccount.minimal,
          host: host?.minimal,
          user: req.remoteUser.minimal,
          fromCollective: fromAccount.minimal,
          order: order.info,
          messageForContributor,
          messageSource: 'HOST',
          hostAction: { cancel, refund: Boolean(refundTransactions?.length), removeAsContributor },
        },
      });
    }
  });

  // Refunds: processed best-effort, outside the DB transaction, so that partial
  // success is possible. Each refund goes through the same authoritative path
  // (`refundTransaction`) used by the ledger's refundTransaction mutation, with
  // `ignoreBalanceCheck: true` since the host is knowingly overriding it.
  if (refundTransactions?.length) {
    for (const tx of refundTransactions) {
      try {
        const refunded = await refundTransaction(tx, req, RefundKind.REFUND, {
          ignoreBalanceCheck: true,
          message: messageForContributor ?? undefined,
        });
        refundedTransactions.push(refunded);
      } catch (error) {
        logger.warn(
          `manageOrder: failed to refund transaction ${tx.id} for order ${order.id}: ${(error as Error)?.message}`,
        );
        refundErrors.push({
          transaction: tx,
          message: (error as Error)?.message ?? 'Unknown error',
          code: classifyRefundError(error),
        });
      }
    }

    if (refundedTransactions.length > 0) {
      activitiesToCreate.push({
        type: activities.CONTRIBUTION_REFUNDED_BY_HOST,
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        HostCollectiveId: hostCollectiveId,
        OrderId: order.id,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        data: {
          collective: toAccount.minimal,
          host: host?.minimal,
          user: req.remoteUser.minimal,
          fromCollective: fromAccount.minimal,
          order: order.info,
          refundCount: refundedTransactions.length,
          refundedTransactionIds: uniq(refundedTransactions.map(t => t.id)),
          refundErrors: refundErrors.map(e => ({ TransactionId: e.transaction.id, message: e.message, code: e.code })),
          messageForContributor,
          messageSource: 'HOST',
          hostAction: { cancel, refund: true, removeAsContributor },
        },
      });
    }
  }

  // Cache invalidation for the two profiles affected (backer + collective)
  if (removeAsContributor || cancel) {
    purgeCacheForCollective(fromAccount.slug);
    purgeCacheForCollective(toAccount.slug);
  }

  // Create all activities after the transactional work has committed.
  for (const activityData of activitiesToCreate) {
    try {
      await models.Activity.create(activityData);
    } catch (error) {
      logger.warn(
        `manageOrder: failed to create activity ${activityData.type} for order ${order.id}: ${(error as Error)?.message}`,
      );
    }
  }

  // Reload the order to reflect the latest state (status, subscription) before returning.
  const reloadedOrder = await models.Order.findByPk(order.id, {
    include: [
      { model: models.Subscription },
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });

  return {
    order: reloadedOrder ?? order,
    refundedTransactions,
    refundErrors,
  };
}
