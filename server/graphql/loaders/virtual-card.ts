import DataLoader from 'dataloader';

import models, { Op } from '../../models/index.js';
import VirtualCard from '../../models/VirtualCard.js';

import { sortResultsArray } from './helpers.js';

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
