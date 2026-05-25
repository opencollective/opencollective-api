/* eslint-disable camelcase */
import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { run as checkPendingPaypalExpenses } from '../../../cron/hourly/11-check-pending-paypal-expenses';
import status from '../../../server/constants/expense-status';
import { markExpenseAsUnpaid } from '../../../server/graphql/common/expenses';
import * as paypalLib from '../../../server/lib/paypal';
import { sequelize } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import * as payouts from '../../../server/paymentProviders/paypal/payouts';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
  multiple,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/11-check-pending-paypal-expenses', () => {
  const sandbox = createSandbox();
  let checkBatchStatus;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    checkBatchStatus = sandbox.stub(payouts, 'checkBatchStatus').resolves();
  });

  const makePaypalPayoutMethod = () =>
    fakePayoutMethod({
      type: PayoutMethodTypes.PAYPAL,
      data: { email: 'test@example.com' },
    });

  /** Force-sets updatedAt on an expense via a raw SQL UPDATE (Sequelize ignores it on create/update) */
  const setUpdatedAt = async (expense, date) => {
    await sequelize.query(`UPDATE "Expenses" SET "updatedAt" = :date WHERE id = :id`, {
      replacements: { date: date.toISOString(), id: expense.id },
    });
  };

  it('does NOT pick up expenses without a payout_batch_id', async () => {
    const collective = await fakeCollective({ hasMoneyManagement: true });
    const payoutMethod = await makePaypalPayoutMethod();
    const expense = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: {},
    });
    await setUpdatedAt(expense, moment().subtract(1, 'hour').toDate());

    await checkPendingPaypalExpenses();

    expect(checkBatchStatus.callCount).to.equal(0);
  });

  it('does NOT pick up expenses with a non-PayPal payout method', async () => {
    const collective = await fakeCollective({ hasMoneyManagement: true });
    const bankPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.BANK_ACCOUNT });
    const expense = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: bankPayoutMethod.id,
      data: { payout_batch_id: 'batch-bank' },
    });
    await setUpdatedAt(expense, moment().subtract(1, 'hour').toDate());

    await checkPendingPaypalExpenses();

    expect(checkBatchStatus.callCount).to.equal(0);
  });

  it('groups expenses by payout_batch_id and calls checkBatchStatus once per batch', async () => {
    const collective = await fakeCollective({ hasMoneyManagement: true });
    const payoutMethod = await makePaypalPayoutMethod();
    const oneHourAgo = moment().subtract(1, 'hour').toDate();

    // Two expenses in the same batch
    const expenseA1 = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-A' },
    });
    const expenseA2 = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-A' },
    });

    // One expense in a different batch
    const expenseB = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-B' },
    });

    await Promise.all([
      setUpdatedAt(expenseA1, oneHourAgo),
      setUpdatedAt(expenseA2, oneHourAgo),
      setUpdatedAt(expenseB, oneHourAgo),
    ]);

    await checkPendingPaypalExpenses();

    expect(checkBatchStatus.callCount).to.equal(2);

    const callArgs = [checkBatchStatus.getCall(0).args[0], checkBatchStatus.getCall(1).args[0]];
    const batchIds = callArgs.map(batch => batch[0].data.payout_batch_id);
    expect(batchIds).to.include.members(['batch-A', 'batch-B']);

    // The batch-A call should have 2 expenses
    const batchACall = callArgs.find(batch => batch[0].data.payout_batch_id === 'batch-A');
    expect(batchACall).to.have.lengthOf(2);
  });

  it('continues processing other batches when one batch throws an error', async () => {
    const collective = await fakeCollective({ hasMoneyManagement: true });
    const payoutMethod = await makePaypalPayoutMethod();
    const oneHourAgo = moment().subtract(1, 'hour').toDate();

    const expenseFail = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-fail' },
    });
    const expenseOk = await fakeExpense({
      status: status.PROCESSING,
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-ok' },
    });

    await Promise.all([setUpdatedAt(expenseFail, oneHourAgo), setUpdatedAt(expenseOk, oneHourAgo)]);

    checkBatchStatus.onFirstCall().rejects(new Error('Could not find the host paying the expense.'));
    checkBatchStatus.onSecondCall().resolves();

    // Should not throw
    await expect(checkPendingPaypalExpenses()).to.be.fulfilled;
    expect(checkBatchStatus.callCount).to.equal(2);
  });

  it('handles multiple collectives with different hosts, one batch each', async () => {
    const payoutMethod = await makePaypalPayoutMethod();
    const oneHourAgo = moment().subtract(1, 'hour').toDate();
    const collectives = await multiple(fakeCollective, 3, { hasMoneyManagement: true });

    for (const [i, collective] of collectives.entries()) {
      const expense = await fakeExpense({
        status: status.PROCESSING,
        CollectiveId: collective.id,
        PayoutMethodId: payoutMethod.id,
        data: { payout_batch_id: `batch-host-${i}` },
      });
      await setUpdatedAt(expense, oneHourAgo);
    }

    await checkPendingPaypalExpenses();

    expect(checkBatchStatus.callCount).to.equal(3);
  });

  it('does not re-pay an expense that was paid then marked as unpaid', async () => {
    // Use the real checkBatchStatus; only stub the PayPal API HTTP call
    checkBatchStatus.restore();
    sandbox.stub(paypalLib, 'getBatchInfo');

    // Set up a host with a PayPal connected account
    const hostAdmin = await fakeUser();
    const host = await fakeHost({ admin: hostAdmin.collective });
    await hostAdmin.populateRoles();
    await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', clientId: 'fake', token: 'fake' });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.PAYPAL,
      data: { email: 'test@example.com' },
    });

    // Create a PROCESSING expense with a batch ID
    const expense = await fakeExpense({
      status: status.PROCESSING,
      amount: 10000,
      currency: 'USD',
      CollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { payout_batch_id: 'batch-repay-test' },
    });
    expense.collective = collective;

    // Step 1: simulate PayPal reporting the payout as SUCCESS → expense becomes PAID
    paypalLib.getBatchInfo.resolves({
      items: [
        {
          transaction_status: 'SUCCESS',
          payout_batch_id: 'batch-repay-test',
          payout_item: { sender_item_id: expense.id.toString() },
          payout_item_fee: { currency: 'USD', value: '0' },
          time_processed: new Date().toISOString(),
        },
      ],
    });
    await setUpdatedAt(expense, moment().subtract(1, 'hour').toDate());
    await checkPendingPaypalExpenses();
    await expense.reload();
    expect(expense.status).to.equal(status.PAID);

    // Step 2: a host admin marks the expense as unpaid (clears payout_batch_id from data)
    await markExpenseAsUnpaid({ remoteUser: hostAdmin }, expense.id, false);
    await expense.reload();
    expect(expense.status).to.equal(status.APPROVED);
    expect(expense.data.payout_batch_id).to.be.undefined;

    // Step 3: run the cron again — the expense must NOT be picked up or re-paid
    paypalLib.getBatchInfo.reset();
    await checkPendingPaypalExpenses();
    expect(paypalLib.getBatchInfo.callCount).to.equal(0);

    await expense.reload();
    expect(expense.status).to.equal(status.APPROVED);
  });
});
