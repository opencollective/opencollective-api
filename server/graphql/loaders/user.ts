import DataLoader from 'dataloader';

import models from '../../models';

import { sortResultsSimple } from './helpers';

export const generateUserByCollectiveIdLoader = (): DataLoader<number, boolean> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const users = await models.User.findAll({ where: { CollectiveId: collectiveIds } });
    return sortResultsSimple(collectiveIds, users, user => user.CollectiveId);
  });
};
