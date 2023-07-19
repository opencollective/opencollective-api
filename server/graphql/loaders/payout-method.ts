import DataLoader from 'dataloader';

import models, { Op } from '../../models/index.js';
import { PayoutMethod } from '../../models/PayoutMethod.js';

import { sortResultsArray } from './helpers.js';

/**
 * Loader for collective's paypal payout methods
 */
export const generateCollectivePaypalPayoutMethodsLoader = (): DataLoader<number, PayoutMethod[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const payoutMethods = await models.PayoutMethod.scope('paypal').findAll({
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
    const payoutMethods = await models.PayoutMethod.findAll({
      where: { CollectiveId: { [Op.in]: collectiveIds }, isSaved: true },
    });

    return sortResultsArray(collectiveIds, payoutMethods, pm => pm.CollectiveId);
  });
};
