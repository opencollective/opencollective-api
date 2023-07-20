import { main } from '../../../scripts/ledger/update-transactions.js';
import { fakeTransaction } from '../../test-helpers/fake-data.js';
import { resetTestDB, snapshotLedger } from '../../utils.js';

const SNAPSHOT_COLUMNS = ['kind', 'type', 'amount', 'CollectiveId', 'FromCollectiveId', 'HostCollectiveId'];

describe('scripts/ledger/update-transactions', () => {
  before('reset test database', () => resetTestDB());

  it('update hostFeePercent when it does not exists yet', async () => {
    const transaction = await fakeTransaction({ amount: 500, kind: 'CONTRIBUTION' }, { createDoubleEntry: true });
    const collective = await transaction.getCollective();
    await main([
      'npm run script',
      'scripts/ledger/update-transactions.ts',
      '--yes',
      '--account',
      collective.slug,
      '--hostFeePercent',
      '20.00',
    ]);

    snapshotLedger(SNAPSHOT_COLUMNS);
  });
});
