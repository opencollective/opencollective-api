import { expect } from 'chai';
import moment from 'moment';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../server/constants/transactions';
import { getBalances } from '../../../../server/lib/budget';
import { createBalanceCarryforward } from '../../../../server/lib/ledger/carryforward';
import { fakeCollective, fakeHost, fakeTransaction } from '../../../test-helpers/fake-data';
import { resetTestDB, snapshotLedger } from '../../../utils';

const CARRYFORWARD_SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'amountInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isInternal',
  'description',
];

describe('server/lib/ledger/carryforward', () => {
  let host, collective, contributor;

  before(resetTestDB);

  beforeEach(async () => {
    host = await fakeHost({ name: 'Test Host', currency: 'USD' });
    collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id, currency: 'USD' });
    contributor = await fakeCollective({ name: 'Contributor' });
  });

  describe('Ledger snapshot', () => {
    it('ledger state before and after carryforward', async () => {
      // Create a contribution transaction 60 days ago
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 150e2,
          createdAt: moment().subtract(60, 'days').toDate(),
          description: 'Original contribution',
        },
        { createDoubleEntry: true },
      );

      // Snapshot ledger BEFORE carryforward
      await snapshotLedger(CARRYFORWARD_SNAPSHOT_COLUMNS, {
        where: { CollectiveId: collective.id },
        order: [['id', 'ASC']],
      });

      // Create carryforward
      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await createBalanceCarryforward(collective, carryforwardDate);
      expect(result).to.not.be.null;

      // Snapshot ledger AFTER carryforward
      await snapshotLedger(CARRYFORWARD_SNAPSHOT_COLUMNS, {
        where: { CollectiveId: collective.id },
        order: [['id', 'ASC']],
      });

      // Verify balance is unchanged
      const balance = await getBalances([collective.id], { useMaterializedView: false });
      expect(balance[collective.id].value).to.equal(150e2);
    });
  });
});
