import DataLoader from 'dataloader';
import { uniqBy } from 'lodash';

import models, { Collective, Op } from '../../models';
import Agreement from '../../models/Agreement';

import { sortResultsArray } from './helpers';

export const generateAccountCurrentHostAgreementsLoader = () =>
  new DataLoader<Collective, Agreement[], number>(
    async (accounts: Collective[]) => {
      const agreements = await models.Agreement.findAll({
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
        where: {
          [Op.or]: uniqBy(accounts, 'id')
            .filter(c => c.HostCollectiveId && c.approvedAt)
            .map(c => ({ CollectiveId: c.id, HostCollectiveId: c.HostCollectiveId })),
        },
      });

      const getAccountKey = (accountId, hostId) => `${accountId}-${hostId}`;
      const getKeyFromAgreement = agreement => getAccountKey(agreement.CollectiveId, agreement.HostCollectiveId);
      const sourceAccountsKeys = accounts.map(collective => getAccountKey(collective.id, collective.HostCollectiveId));
      return sortResultsArray(sourceAccountsKeys, agreements, getKeyFromAgreement);
    },
    {
      cacheKeyFn: collective => collective.id,
    },
  );
