import { main as splitPaymentProcessorFees } from '../../../scripts/ledger/split-payment-processor-fees';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { refundTransaction } from '../../../server/lib/payments';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors, snapshotLedger } from '../../utils';

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'paymentProcessorFeeInHostCurrency',
  'netAmountInCollectiveCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isRefund',
];

describe('scripts/ledger/split-payment-processor-fees', () => {
  beforeEach('reset test database', async () => {
    await resetTestDB();
    await seedDefaultVendors();
  });

  it('1. migrate a regular contribution with payment processor fees', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    await fakeTransaction(
      {
        amount: 500,
        kind: TransactionKind.CONTRIBUTION,
        paymentProcessorFeeInHostCurrency: -25,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
      },
      { createDoubleEntry: true },
    );
    await snapshotLedger(SNAPSHOT_COLUMNS);

    await splitPaymentProcessorFees('migrate');

    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('2. migrate a regular refunded contribution with payment processor fees', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    const transaction = await fakeTransaction(
      {
        amount: 500,
        kind: TransactionKind.CONTRIBUTION,
        paymentProcessorFeeInHostCurrency: -25,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
      },
      { createDoubleEntry: true },
    );

    // Refund the transaction
    await refundTransaction(transaction, user);
    await snapshotLedger(SNAPSHOT_COLUMNS);

    await splitPaymentProcessorFees('migrate');

    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('3. migrate an expense with payment processor fees', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });

    await fakeTransaction(
      {
        amount: -500,
        kind: TransactionKind.EXPENSE,
        paymentProcessorFeeInHostCurrency: -25,
        netAmountInCollectiveCurrency: -525,
        currency: 'USD',
        hostCurrency: 'USD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
      },
      { createDoubleEntry: true },
    );

    await snapshotLedger(SNAPSHOT_COLUMNS);

    await splitPaymentProcessorFees('migrate');

    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('4. migrate an expense with payment processor fees AND taxes', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    await fakeTransaction(
      {
        amount: -500,
        kind: TransactionKind.EXPENSE,
        paymentProcessorFeeInHostCurrency: -25,
        netAmountInCollectiveCurrency: -675,
        currency: 'USD',
        hostCurrency: 'USD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        taxAmount: -150,
        HostCollectiveId: host.id,
      },
      { createDoubleEntry: true },
    );
    await snapshotLedger([...SNAPSHOT_COLUMNS, 'taxAmount']);
    await splitPaymentProcessorFees('migrate');
    await snapshotLedger([...SNAPSHOT_COLUMNS, 'taxAmount']);
  });

  // select * from "Transactions" where kind = 'EXPENSE' AND data ->> 'feesPayer' = 'PAYEE' LIMIT 100
  it('5. migrate an expense with processor fees on the payee if feesPayer=PAYEE', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    await fakeTransaction(
      {
        amount: -475,
        kind: TransactionKind.EXPENSE,
        paymentProcessorFeeInHostCurrency: -25,
        netAmountInCollectiveCurrency: -500,
        currency: 'USD',
        hostCurrency: 'USD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: { feesPayer: 'PAYEE' },
      },
      { createDoubleEntry: true },
    );
    await snapshotLedger([...SNAPSHOT_COLUMNS, 'taxAmount']);
    await splitPaymentProcessorFees('migrate');
    await snapshotLedger([...SNAPSHOT_COLUMNS, 'taxAmount']);
  });

  // TODO
  //
  // it('handles multi-currency contributions with refunds', () => {})
  // it('handles multi-currency expenses with refunds', () => {})
});
