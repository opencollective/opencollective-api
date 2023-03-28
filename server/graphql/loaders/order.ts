import DataLoader from 'dataloader';

import ACTIVITY from '../../constants/activities';
import models, { Op } from '../../models';
import { Activity } from '../../models/Activity';

import { sortResultsArray } from './helpers';

/**
 * Load all activities for an order
 */
export const generateOrderActivitiesLoader = (): DataLoader<number, Activity[]> => {
  return new DataLoader(async (orderIDs: number[]) => {
    const activities = await models.Activity.findAll({
      order: [['createdAt', 'ASC']],
      where: {
        OrderId: {
          [Op.in]: orderIDs,
        },
        type: {
          [Op.in]: [ACTIVITY.COLLECTIVE_TRANSACTION_CREATED],
        },
      },
    });
    return sortResultsArray(orderIDs, activities, activity => activity.OrderId);
  });
};
