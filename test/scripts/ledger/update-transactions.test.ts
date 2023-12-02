import { main } from '../../../scripts/ledger/update-transactions';
import { fakeTransaction } from '../../test-helpers/fake-data';
import { resetTestDB, snapshotLedger } from '../../utils';

const SNAPSHOT_COLUMNS = ['kind', 'type', 'amount', 'CollectiveId', 'FromCollectiveId', 'HostCollectiveId'];

describe('scripts/ledger/update-transactions', () => {
  before('reset test database', () => resetTestDB());

  it('update hostFeePercent when it does not exists yet', async () => {
    const transaction = await fakeTransaction({ amount: 500, kind: 'CONTRIBUTION' }, { createDoubleEntry: true });
    const collective = await transaction.getCollective();
    await main([
      'pnpm script',
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
