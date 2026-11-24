import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261124150000-speed-up-host-monthly-transactions-view'; // eslint-disable-line import/default
import { TransactionKind } from '../../server/constants/transaction-kind';
import { sequelize } from '../../server/models';
import {
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeHost,
  fakeProject,
  fakeTransaction,
  fakeVendor,
} from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

const getViewRows = async () => {
  await sequelize.query(`REFRESH MATERIALIZED VIEW "HostMonthlyTransactions"`);
  const rows = await sequelize.query<Record<string, unknown>>(`SELECT * FROM "HostMonthlyTransactions"`, {
    type: QueryTypes.SELECT,
  });
  // The view is only ordered by date, host and kind: sort on every column to compare rows
  return rows
    .map(({ refreshedAt, ...row }) => {
      expect(refreshedAt).to.exist;
      return row;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

describe('migrations/20261124150000-speed-up-host-monthly-transactions-view', () => {
  before(async () => {
    await resetTestDB();

    const host = await fakeHost({ currency: 'USD' });
    const otherHost = await fakeHost({ currency: 'EUR' });
    const event = await fakeEvent({ ParentCollectiveId: host.id, HostCollectiveId: host.id });
    const project = await fakeProject({ ParentCollectiveId: host.id, HostCollectiveId: host.id });
    const vendor = await fakeVendor({ ParentCollectiveId: host.id });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id });
    const childOfOtherHost = await fakeProject({ ParentCollectiveId: otherHost.id, HostCollectiveId: host.id });
    const invoice = await fakeExpense({ type: 'INVOICE', CollectiveId: collective.id });
    const receipt = await fakeExpense({ type: 'RECEIPT', CollectiveId: event.id });

    const dates = ['2025-01-15T10:00:00Z', '2025-01-31T23:30:00Z', '2025-02-01T00:30:00Z', '2025-06-10T12:00:00Z'];
    for (const createdAt of dates) {
      for (const account of [host, event, project, vendor, collective, childOfOtherHost]) {
        await fakeTransaction({
          createdAt: new Date(createdAt),
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          kind: TransactionKind.CONTRIBUTION,
          amount: 1000,
          hostFeeInHostCurrency: -50,
          platformFeeInHostCurrency: -20,
          paymentProcessorFeeInHostCurrency: -30,
          taxAmount: -100,
          hostCurrencyFxRate: 1.1,
        });
      }

      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        ExpenseId: invoice.id,
        kind: TransactionKind.EXPENSE,
        amount: -500,
      });
      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: event.id,
        HostCollectiveId: host.id,
        ExpenseId: receipt.id,
        kind: TransactionKind.EXPENSE,
        amount: -300,
      });
      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: -1000,
        isRefund: true,
      });
      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: otherCollective.id,
        HostCollectiveId: otherHost.id,
        kind: TransactionKind.ADDED_FUNDS,
        amount: 700,
        currency: 'EUR',
        hostCurrency: 'EUR',
      });
      // Ignored by the view: deleted, or without host
      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: 999,
        deletedAt: new Date(),
      });
      await fakeTransaction({
        createdAt: new Date(createdAt),
        CollectiveId: collective.id,
        HostCollectiveId: null,
        kind: TransactionKind.CONTRIBUTION,
        amount: 888,
      });
    }
  });

  after(async () => {
    // Leave the view with the new definition, as after `db:migrate`
    await migration.up(sequelize.getQueryInterface());
  });

  it('returns the same rows as the previous definition', async () => {
    const queryInterface = sequelize.getQueryInterface();

    await migration.down(queryInterface);
    const previousRows = await getViewRows();

    await migration.up(queryInterface);
    const newRows = await getViewRows();

    expect(previousRows.length).to.be.greaterThan(10);
    expect(newRows).to.deep.equal(previousRows);

    // The fixtures cover every branch of `isHost` and `expenseType`
    expect(newRows.some(row => row.isHost === true)).to.be.true;
    expect(newRows.some(row => row.isHost === false)).to.be.true;
    expect(newRows.some(row => row.expenseType === 'INVOICE')).to.be.true;
    expect(newRows.some(row => row.expenseType === 'RECEIPT')).to.be.true;
    expect(newRows.some(row => row.isRefund === true)).to.be.true;
  });
});
