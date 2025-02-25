import DataLoader from 'dataloader';

import { Op, PayoutMethod } from '../../models';

import { sortResultsArray } from './helpers';

/**
 * Loader for collective's paypal payout methods
 */
export const generateCollectivePaypalPayoutMethodsLoader = (): DataLoader<number, PayoutMethod[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const payoutMethods = await PayoutMethod.scope('paypal').findAll({
      where: { CollectiveId: { [Op.in]: collectiveIds }, isSaved: true },
    });

    return sortResultsArray(collectiveIds, payoutMethods, pm => pm.CollectiveId);
  });
};

/**
 * Loader for all collective's payout methods
 */
export function generateCollectivePayoutMethodsLoader({ excludeArchived = true } = {}): DataLoader<
  number,
  PayoutMethod[]
> {
  return new DataLoader(async (collectiveIds: number[]) => {
    const where = { CollectiveId: { [Op.in]: collectiveIds } };
    if (excludeArchived) {
      where['isSaved'] = true;
    }
    const payoutMethods = await PayoutMethod.findAll({
      where,
    });

    return sortResultsArray(collectiveIds, payoutMethods, pm => pm.CollectiveId);
  });
}
