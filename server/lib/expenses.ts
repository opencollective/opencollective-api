import { isNull, merge, omitBy } from 'lodash';

import ExpenseStatus from '../constants/expense-status';
import { Loaders } from '../graphql/loaders';
import { Collective, Expense } from '../models';

import { FEATURE, hasFeature } from './allowed-features';

/**
 * Paid expenses belong to their paying host. Other expenses use the approved current account/parent
 * host when the historical host is absent or stale. Callbacks let collection queries batch the reads.
 */
export const getExpenseHost = async (
  expense: Pick<Expense, 'CollectiveId' | 'HostCollectiveId' | 'status' | 'collective'>,
  {
    getCollectiveById,
    isApproved,
  }: {
    getCollectiveById: (id: number) => Promise<Collective | null>;
    isApproved: (id: number) => Promise<boolean>;
  },
): Promise<Collective | null> => {
  const collective = expense.collective || (await getCollectiveById(expense.CollectiveId));
  if (!collective) {
    return null;
  }

  const hasStaleHost =
    expense.HostCollectiveId &&
    expense.HostCollectiveId !== collective.HostCollectiveId &&
    expense.status !== ExpenseStatus.PAID;
  if (expense.HostCollectiveId && !hasStaleHost) {
    return getCollectiveById(expense.HostCollectiveId);
  }

  if (collective.HostCollectiveId && (await isApproved(collective.id))) {
    const host = collective.host || (await getCollectiveById(collective.HostCollectiveId));
    if (host) {
      return host;
    }
  }

  const parent = collective.ParentCollectiveId && (await getCollectiveById(collective.ParentCollectiveId));
  return parent?.HostCollectiveId && (await isApproved(parent.id))
    ? parent.host || getCollectiveById(parent.HostCollectiveId)
    : null;
};

export const getSupportedExpenseTypes = async (
  collective: Collective,
  { loaders = null }: { loaders?: Loaders } = {},
) => {
  const getCollectiveById = async (id: number) =>
    loaders ? loaders.Collective.byId.load(id) : await Collective.findByPk(id);

  const host = collective.hasMoneyManagement
    ? collective
    : collective.host || (collective.HostCollectiveId && (await getCollectiveById(collective.HostCollectiveId)));
  const parent = collective.ParentCollectiveId && (await getCollectiveById(collective.ParentCollectiveId));

  // Aggregate all configs, using the order of priority collective > parent > host
  const getExpenseTypes = account => omitBy(account?.settings?.expenseTypes, isNull);
  const defaultExpenseTypes = { GRANT: false, INVOICE: true, RECEIPT: true };
  const aggregatedConfig = merge(defaultExpenseTypes, ...[host, parent, collective].map(getExpenseTypes));
  const supportedFromConfig = Object.keys(aggregatedConfig).filter(key => aggregatedConfig[key]); // Return only the truthy ones
  if (supportedFromConfig.includes('GRANT')) {
    const hasGrantsFeature = await hasFeature(host, FEATURE.FUNDS_GRANTS_MANAGEMENT, { loaders });
    if (!hasGrantsFeature) {
      return supportedFromConfig.filter(type => type !== 'GRANT');
    }
  }

  return supportedFromConfig;
};
