import config from 'config';
import { createSandbox } from 'sinon';

import { main as splitTaxes } from '../../../scripts/ledger/split-taxes';
import { refundTransaction } from '../../../server/lib/payments';
import Transaction from '../../../server/models/Transaction';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors, snapshotLedger } from '../../utils';

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'currency',
  'hostCurrency',
  'taxAmount',
  'netAmountInCollectiveCurrency',
  'amountInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isRefund',
];

describe('scripts/ledger/split-taxes', () => {
  let sandbox;

  beforeEach('reset test database', async () => {
    await resetTestDB();
    await seedDefaultVendors();
    sandbox = createSandbox();
    sandbox.stub(config, 'activities').value({ ...config.activities, skipCreationForTransactions: true }); // Async activities are created async, which doesn't play well with `resetTestDb`
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('1. migrate a regular contribution with taxes', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host', currency: 'NZD', countryISO: 'NZ' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    const transaction = await fakeTransaction(
      {
        amount: 500,
        netAmountInCollectiveCurrency: 475,
        amountInHostCurrency: 500,
        taxAmount: -25,
        type: 'CREDIT',
        kind: 'CONTRIBUTION',
        currency: 'NZD',
        hostCurrency: 'NZD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          tax: {
            id: 'GST',
            percentage: 15,
            taxIDNumber: null,
            taxedCountry: 'NZ',
            taxerCountry: 'NZ',
            taxIDNumberFrom: '131-952-775',
          },
        },
      },
      { createDoubleEntry: true },
    );

    await Transaction.validate(transaction, { validateOppositeTransaction: true });

    await snapshotLedger(SNAPSHOT_COLUMNS);
    await splitTaxes('migrate');
    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('2. migrate a regular refunded contribution with taxes', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host', currency: 'NZD', countryISO: 'NZ' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
    const transaction = await fakeTransaction(
      {
        amount: 500,
        netAmountInCollectiveCurrency: 475,
        amountInHostCurrency: 500,
        taxAmount: -25,
        kind: 'CONTRIBUTION',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        currency: 'NZD',
        hostCurrency: 'NZD',
        data: {
          tax: {
            id: 'GST',
            percentage: 15,
            taxIDNumber: null,
            taxedCountry: 'NZ',
            taxerCountry: 'NZ',
            taxIDNumberFrom: '131-952-775',
          },
        },
      },
      { createDoubleEntry: true },
    );

    await Transaction.validate(transaction, { validateOppositeTransaction: true });

    await refundTransaction(transaction, user);
    await snapshotLedger(SNAPSHOT_COLUMNS);
    await splitTaxes('migrate');
    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('3. migrate an expense with taxes', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });

    const transaction = await fakeTransaction(
      {
        amount: -500,
        netAmountInCollectiveCurrency: -525,
        taxAmount: -25,
        amountInHostCurrency: -500,
        type: 'DEBIT',
        kind: 'EXPENSE',
        currency: 'USD',
        hostCurrency: 'USD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          tax: {
            id: 'GST',
            percentage: 15,
            taxIDNumber: null,
            taxedCountry: 'NZ',
            taxerCountry: 'NZ',
            taxIDNumberFrom: '131-952-775',
          },
        },
      },
      { createDoubleEntry: true },
    );

    await Transaction.validate(transaction, { validateOppositeTransaction: true });

    await snapshotLedger(SNAPSHOT_COLUMNS);
    await splitTaxes('migrate');
    await snapshotLedger(SNAPSHOT_COLUMNS);
  });

  it('4. migrate an expense with taxes that get marked as UNPAID', async () => {
    const user = await fakeUser(null, { name: 'User' });
    const host = await fakeHost({ name: 'Host' });
    const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });

    const transaction = await fakeTransaction(
      {
        amount: -500,
        netAmountInCollectiveCurrency: -525,
        taxAmount: -25,
        amountInHostCurrency: -500,
        type: 'DEBIT',
        kind: 'EXPENSE',
        currency: 'USD',
        hostCurrency: 'USD',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          tax: {
            id: 'GST',
            percentage: 15,
            taxIDNumber: null,
            taxedCountry: 'NZ',
            taxerCountry: 'NZ',
            taxIDNumberFrom: '131-952-775',
          },
        },
      },
      { createDoubleEntry: true },
    );

    await Transaction.validate(transaction, { validateOppositeTransaction: true });
    await refundTransaction(transaction, user);

    await snapshotLedger(SNAPSHOT_COLUMNS);
    await splitTaxes('migrate');
    await snapshotLedger(SNAPSHOT_COLUMNS);
  });
});
