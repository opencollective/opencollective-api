import express from 'express';
import moment from 'moment';

import { roles } from '../../constants';
import orderStatus from '../../constants/order_status';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models from '../../models';

const getPayee = async (req, transaction) => {
  let column;
  if (transaction.type === 'CREDIT') {
    column = !transaction.isRefund ? 'CollectiveId' : 'FromCollectiveId';
  } else {
    column = !transaction.isRefund ? 'FromCollectiveId' : 'CollectiveId';
  }

  return req.loaders.Collective.byId.load(transaction[column]);
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
export const canRefund = async (
  transaction: typeof models.Transaction,
  _: void,
  req: express.Request,
): Promise<boolean> => {
  if (transaction.type !== TransactionTypes.CREDIT || transaction.OrderId === null || transaction.isRefund === true) {
    return false;
  }

  const timeLimit = moment().subtract(30, 'd');
  const createdAtMoment = moment(transaction.createdAt);
  const transactionIsOlderThanThirtyDays = createdAtMoment < timeLimit;
  /*
   * 1) We only allow the transaction to be refunded by Collective admins if it's within 30 days.
   *
   * 2) To ensure proper accounting, we only allow added funds to be refunded by Host admins and never by Collective admins.
   */
  if (transactionIsOlderThanThirtyDays || transaction.kind === TransactionKind.ADDED_FUNDS) {
    return remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin]);
  } else {
    return remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin, isPayeeCollectiveAdmin]);
  }
};

export const canDownloadInvoice = async (
  transaction: typeof models.Transaction,
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
    isPayeeHostAdmin,
    isPayerAccountant,
    isPayeeAccountant,
  ]);
};

/** Checks if the user can reject this transaction */
export const canReject = async (
  transaction: typeof models.Transaction,
  _: void,
  req: express.Request,
): Promise<boolean> => {
  if (transaction.type !== TransactionTypes.CREDIT || transaction.OrderId === null) {
    return false;
  }
  const timeLimit = moment().subtract(30, 'd');
  const createdAtMoment = moment(transaction.createdAt);
  const transactionIsOlderThanThirtyDays = createdAtMoment < timeLimit;
  if (transactionIsOlderThanThirtyDays) {
    return remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin]);
  } else {
    return remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin, isPayeeCollectiveAdmin]);
  }
};
