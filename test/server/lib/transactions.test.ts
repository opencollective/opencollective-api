import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import * as libtransactions from '../../../server/lib/transactions';
import models from '../../../server/models';
import * as store from '../../stores';
import { fakeExpense } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/lib/transactions', () => {
  beforeEach(utils.resetTestDB);

  it('exports transactions', async () => {
    // Given a host with a collective
    const currency = 'USD';
    const { collective } = await store.newCollectiveWithHost('apex', currency, currency, '10');
    const { user } = await store.newUser('a new user');
    // And given some transactions
    await store.stripeConnectedAccount(collective.HostCollectiveId);
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 100,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 200,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 300,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 400,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 500,
    });
    const transactions = await models.Transaction.findAll({
      where: { CollectiveId: collective.id },
    });
    // Expected total
    // - 5 for CONTRIBUTIONs
    // - 5 for HOST_FEEs
    expect(transactions.length).to.equal(10);
    // When the newly created transactions are exported
    const csv = libtransactions.exportTransactions(transactions);
    const lines = csv.split('\n');
    expect(lines.length).to.equal(11);
    expect(lines[0].split('","').length).to.equal(12);
  }); /* End of "exports transactions" */

  describe('createTransactionsFromPaidExpense', () => {
    const sandbox = createSandbox();
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });
    afterEach(() => sandbox.restore());

    it('creates transactions with clearedAt date for a paid expense', async () => {
      const expense = await fakeExpense({ amount: 10000, status: 'PAID' });

      await libtransactions.createTransactionsFromPaidExpense(
        expense.collective.host,
        expense,
        {
          hostFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: -390,
        },
        1,
        { clearedAt: new Date('2024-02-20T00:00:00Z') },
      );

      const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(transactions).to.not.be.empty;
      for (const transaction of transactions) {
        expect(transaction.clearedAt.toISOString()).to.equal('2024-02-20T00:00:00.000Z');
      }
    });
  });

  describe('createTransactionsForManuallyPaidExpense', () => {
    const sandbox = createSandbox();
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });
    afterEach(() => sandbox.restore());

    it('creates transactions with clearedAt date for a paid expense', async () => {
      const expense = await fakeExpense({ amount: 10000, status: 'PAID' });

      await libtransactions.createTransactionsForManuallyPaidExpense(expense.collective.host, expense, 100, 9900, {
        clearedAt: new Date('2024-02-20T00:00:00Z'),
      });

      const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(transactions).to.not.be.empty;
      for (const transaction of transactions) {
        expect(transaction.clearedAt.toISOString()).to.equal('2024-02-20T00:00:00.000Z');
      }
    });
  });
}); /* End of "lib.transactions.test.js" */
