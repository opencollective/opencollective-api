import DataLoader from 'dataloader';

import { Op } from '../../lib/sequelize';
import VirtualCard from '../../models/VirtualCard';

import { sortResultsArray } from './helpers';

export const generateCollectiveVirtualCardLoader = (): DataLoader<number, VirtualCard[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const virtualCards = await VirtualCard.findAll({
      where: { CollectiveId: { [Op.in]: collectiveIds } },
    });

    return sortResultsArray(collectiveIds, virtualCards, vc => vc.CollectiveId);
  });
};

export const generateHostCollectiveVirtualCardLoader = (): DataLoader<number, VirtualCard[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const virtualCards = await VirtualCard.findAll({
      where: { HostCollectiveId: { [Op.in]: collectiveIds } },
    });

    return sortResultsArray(collectiveIds, virtualCards, vc => vc.HostCollectiveId);
  });
};
