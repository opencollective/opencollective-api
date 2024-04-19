import express from 'express';
import { isNull } from 'lodash';
import moment from 'moment';

import { roles } from '../../constants';
import orderStatus from '../../constants/order-status';
import POLICIES from '../../constants/policies';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import * as libPayments from '../../lib/payments';
import { getPolicy } from '../../lib/policies';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import models from '../../models';
import { TransactionInterface } from '../../models/Transaction';
import { Forbidden, NotFound } from '../errors';

import { isHostAdmin } from './expenses';

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

const isRoot = async (req: express.Request): Promise<boolean> => {
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

const isPayeeHostAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const payee = await getPayee(req, transaction);
  return payee?.HostCollectiveId && req.remoteUser.isAdmin(payee.HostCollectiveId);
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
export const canRefund = async (transaction: TransactionInterface, _: void, req: express.Request): Promise<boolean> => {
  if (transaction.type !== TransactionTypes.CREDIT || transaction.OrderId === null || transaction.isRefund === true) {
    return false;
  }
  if (transaction.OrderId) {
    const order = await req.loaders.Order.byId.load(transaction.OrderId);
    if ([orderStatus.REJECTED, orderStatus.REFUNDED].includes(order.status)) {
      return false;
    }
  }

  // 1) We only allow the transaction to be refunded by Collective admins if it's within 30 days.
  // 2) To ensure proper accounting, we only allow added funds to be refunded by Host admins and never by Collective admins.
  if (await remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin])) {
    return true;
  } else if (await isPayeeCollectiveAdmin(req, transaction)) {
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
  } else {
    return false;
  }
};

export const canDownloadInvoice = async (
  transaction: TransactionInterface,
  _: void,
  req: express.Request,
): Promise<boolean> => {
  if (transaction.OrderId) {
    const order = await req.loaders.Order.byId.load(transaction.OrderId);
    if (order.status === orderStatus.REJECTED) {
      return false;
    }
  }
  return remoteUserMeetsOneCondition(req, transaction, [
    isPayerCollectiveAdmin,
    isHostAdmin,
    isPayeeHostAdmin,
    isPayerAccountant,
    isPayeeAccountant,
  ]);
};

/** Checks if the user can reject this transaction */
export const canReject = canRefund;

export async function refundTransaction(
  passedTransaction: TransactionInterface,
  req: express.Request,
  args: { message?: string } = {},
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

  // Check 2FA
  const collective = transaction.type === 'CREDIT' ? transaction.collective : transaction.fromCollective;
  if (collective && req.remoteUser.isAdminOfCollective(collective)) {
    await twoFactorAuthLib.enforceForAccount(req, collective);
  } else {
    const creditTransaction = transaction.type === 'CREDIT' ? transaction : await transaction.getOppositeTransaction();
    if (req.remoteUser.isAdmin(creditTransaction?.HostCollectiveId)) {
      await twoFactorAuthLib.enforceForAccount(
        req,
        await creditTransaction.getHostCollective({ loaders: req.loaders }),
      );
    }
  }

  // 2. Refund via payment method
  // 3. Create new transactions with the refund value in our database
  const result = await libPayments.refundTransaction(transaction, req.remoteUser, args.message);

  // Return the transaction passed to the `refundTransaction` method
  // after it was updated.
  return result;
}
