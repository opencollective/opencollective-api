import DataLoader from 'dataloader';

import Location from '../../models/Location';

import { sortResultsSimple } from './helpers';

export default {
  /**
   * Returns the location for this collective ID
   */
  byCollectiveId: (): DataLoader<number, Location> => {
    return new DataLoader(async collectiveIds => {
      const locations = await Location.findAll({ where: { CollectiveId: collectiveIds } });

      return sortResultsSimple(collectiveIds, locations, result => result.dataValues['CollectiveId']);
    });
  },
};
