import DataLoader from 'dataloader';

import models, { Op } from '../../models';
import VirtualCard from '../../models/VirtualCard';

import { sortResultsArray } from './helpers';

export const generateCollectiveVirtualCardLoader = (): DataLoader<number, VirtualCard[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const virtualCards = await models.VirtualCard.findAll({
      where: { CollectiveId: { [Op.in]: collectiveIds } },
    });

    return sortResultsArray(collectiveIds, virtualCards, vc => vc.CollectiveId);
  });
};

export const generateHostCollectiveVirtualCardLoader = (): DataLoader<number, VirtualCard[]> => {
  return new DataLoader(async (collectiveIds: number[]) => {
    const virtualCards = await models.VirtualCard.findAll({
      where: { HostCollectiveId: { [Op.in]: collectiveIds } },
    });

    return sortResultsArray(collectiveIds, virtualCards, vc => vc.HostCollectiveId);
  });
};
