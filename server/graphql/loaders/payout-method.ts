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
export const generateCollectivePayoutMethodsLoader = (): DataLoader<number, PayoutMethod[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const payoutMethods = await PayoutMethod.findAll({
      where: { CollectiveId: { [Op.in]: collectiveIds }, isSaved: true },
    });

    return sortResultsArray(collectiveIds, payoutMethods, pm => pm.CollectiveId);
  });
};
