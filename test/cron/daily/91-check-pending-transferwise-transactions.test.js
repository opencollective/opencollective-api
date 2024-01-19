import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { run as checkPendingTransfers } from '../../../cron/daily/91-check-pending-transferwise-transactions';
import { roles } from '../../../server/constants';
import status from '../../../server/constants/expense-status';
import emailLib from '../../../server/lib/email';
import logger from '../../../server/lib/logger';
import * as transferwiseLib from '../../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeMember,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/daily/check-pending-transferwise-transactions', () => {
  const sandbox = createSandbox();
  let getTransfer, sendMessage;
  let expense, host, collective, payoutMethod;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    getTransfer = sandbox.stub(transferwiseLib, 'getTransfer');
    sendMessage = sandbox.spy(emailLib, 'sendMessage');
  });
  beforeEach(async () => {
    host = await fakeCollective({ isHostAccount: true });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: '33b5e94d-9815-4ebc-b970-3612b6aec332',
      data: { type: 'business', id: 0 },
    });
    collective = await fakeCollective({ HostCollectiveId: host.id });
    payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      data: {
        accountHolderName: 'Leo Kewitz',
        currency: 'EUR',
        type: 'iban',
        legalType: 'PRIVATE',
        details: {
          IBAN: 'DE89370400440532013000',
        },
      },
    });
    expense = await fakeExpense({
      status: status.PROCESSING,
      amount: 10000,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
      data: {
        transfer: { id: 1234 },
        paymentOption: { fee: { total: 10 }, sourceAmount: 110 },
      },
    });
  });

  it('should complete processing transactions if transfer was sent', async () => {
    getTransfer.resolves({ status: 'outgoing_payment_sent', id: 1234 });
    await checkPendingTransfers();

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
  });

  it('should ignore expenses manually marked as paid', async () => {
    getTransfer.resolves({ status: 'outgoing_payment_sent', id: 1234 });
    const manualExpense = await fakeExpense({
      status: status.PAID,
      amount: 10000,
      CollectiveId: collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
    });

    const spy = sandbox.spy(logger, 'info');

    await checkPendingTransfers();

    assert.calledWith(spy, `Processing expense #${expense.id}...`);
    assert.neverCalledWith(spy, `Processing expense #${manualExpense.id}...`);
  });

  it('should set expense as error and refund existing transactions when funds are refunded', async () => {
    await expense.update({ status: 'PAID' });
    await fakeTransaction(
      {
        type: 'DEBIT',
        amount: -expense.amount,
        FromCollectiveId: expense.FromCollectiveId,
        CollectiveId: expense.CollectiveId,
        ExpenseId: expense.id,
        data: {
          transfer: { id: 1234 },
          quote: { fee: 1, rate: 1 },
          fees: { hostFeeInHostCurrency: 1, platformFeeInHostCurrency: 1 },
        },
      },
      { createDoubleEntry: true },
    );
    getTransfer.resolves({ status: 'funds_refunded', id: 1234 });
    await checkPendingTransfers();

    await expense.reload();
    expect(expense).to.have.property('status', status.ERROR);
    const transactions = await expense.getTransactions();
    expect(transactions).to.containSubset([
      { id: 1, RefundTransactionId: 4 },
      { id: 2, RefundTransactionId: 3 },
    ]);
  });

  it('should send a notification email to the payee and the host when funds are refunded', async () => {
    const admin = await fakeUser({ email: 'admin@oc.com' });
    await fakeMember({ CollectiveId: host.id, MemberCollectiveId: admin.CollectiveId, role: roles.ADMIN });
    getTransfer.resolves({ status: 'funds_refunded', id: 1234 });

    await checkPendingTransfers();

    await utils.waitForCondition(() => sendMessage.callCount === 2);

    expect(sendMessage.args[0][0]).to.equal(expense.User.email);
    expect(sendMessage.args[0][1]).to.contain(
      `Payment from ${collective.name} for ${expense.description} expense failed`,
    );
    expect(sendMessage.args[1][0]).to.equal(admin.email);
    expect(sendMessage.args[1][1]).to.contain(`🚨 Transaction failed on ${collective.name}`);
  });
});
