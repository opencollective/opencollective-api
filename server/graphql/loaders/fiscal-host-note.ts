import DataLoader from 'dataloader';
import { uniq } from 'lodash';

import { FiscalHostNote } from '../../models';

type FiscalHostNoteLoaderKey = {
  hostId: number;
  accountId: number;
};

const getKey = ({ hostId, accountId }: FiscalHostNoteLoaderKey) => `${hostId}-${accountId}`;

/** Batching loader for host/account fiscal host note lookups. */
export const generateFiscalHostNoteByHostAndAccountLoader = () =>
  new DataLoader<FiscalHostNoteLoaderKey, FiscalHostNote | null, string>(
    async keys => {
      const notes = await FiscalHostNote.findAll({
        where: {
          HostCollectiveId: uniq(keys.map(key => key.hostId)),
          CollectiveId: uniq(keys.map(key => key.accountId)),
        },
      });
      const notesByKey = new Map(
        notes.map(note => [getKey({ hostId: note.HostCollectiveId, accountId: note.CollectiveId }), note]),
      );

      return keys.map(key => notesByKey.get(getKey(key)) || null);
    },
    { cacheKeyFn: getKey },
  );
