import { isNull, merge, omitBy } from 'lodash';

import { Loaders } from '../graphql/loaders';
import { Collective } from '../models';

import { FEATURE, hasFeature } from './allowed-features';

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
