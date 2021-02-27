import moment from 'moment';

import { roles } from '../../constants';
import orderStatus from '../../constants/order_status';
import { TransactionTypes } from '../../constants/transactions';

const isRoot = async (req): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  return req.remoteUser.isRoot();
};

const isPayerAccountant = async (req, transaction): Promise<boolean> => {
  const collectiveId = transaction.type === 'DEBIT' ? transaction.CollectiveId : transaction.FromCollectiveId;
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, collectiveId)) {
    return true;
  } else {
    const collective = await req.loaders.Collective.byId.load(collectiveId);
    if (req.remoteUser.hasRole(roles.ACCOUNTANT, collective?.HostCollectiveId)) {
      return true;
    } else if (collective?.ParentCollectiveId) {
      return req.remoteUser.hasRole(roles.ACCOUNTANT, collective.ParentCollectiveId);
    } else {
      return false;
    }
  }
};

const isPayeeAccountant = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  const collective = await req.loaders.Collective.byId.load(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  return req.remoteUser.isAdmin(collective.HostCollectiveId);
};

const isPayerCollectiveAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const collectiveId =
    transaction.type === 'DEBIT'
      ? // If Transaction was paid with Gift Card, only the card issuer has access to it
        transaction.UsingGiftCardFromCollectiveId || transaction.CollectiveId
      : transaction.FromCollectiveId;

  const collective = await req.loaders.Collective.byId.load(collectiveId);

  return req.remoteUser.isAdminOfCollective(collective);
};

const isPayeeHostAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  const collective = await req.loaders.Collective.byId.load(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  return req.remoteUser.isAdmin(collective.HostCollectiveId);
};

const isPayeeCollectiveAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  const collective = await req.loaders.Collective.byId.load(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  return req.remoteUser.isAdminOfCollective(collective);
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

/** Checks if the user can see transaction's attachments (items URLs, attached files) */
export const canRefund = async (transaction, _, req): Promise<boolean> => {
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

export const canDownloadInvoice = async (transaction, _, req): Promise<boolean> => {
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

export const canReject = async (transaction, _, req): Promise<boolean> => {
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
