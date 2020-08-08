import { TransactionTypes } from '../../constants/transactions';

const isRoot = async (req): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  return req.remoteUser.isRoot();
};

const isPayerCollectiveAdmin = async (req, transaction): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const collectiveId = transaction.type === 'DEBIT' ? transaction.CollectiveId : transaction.FromCollectiveId;

  if (req.remoteUser.isAdmin(collectiveId)) {
    return true;
  } else {
    const collective = await req.loaders.Collective.byId.load(collectiveId);
    return req.remoteUser.isAdmin(collective.ParentCollectiveId);
  }
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
  return remoteUserMeetsOneCondition(req, transaction, [isRoot, isPayeeHostAdmin]);
};

export const canDownloadInvoice = async (transaction, _, req): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, transaction, [isPayerCollectiveAdmin, isPayeeHostAdmin]);
};
