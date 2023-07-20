import { expect } from 'chai';
import * as td from 'testdouble';

import status from '../../../server/constants/expense_status.js';
import { roles } from '../../../server/constants/index.js';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod.js';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeMember,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data.js';
import * as utils from '../../utils.js';

describe('cron/daily/check-pending-transferwise-transactions', () => {
  let getTransfer, sendMessage, logger, checkPendingTransfers;
  let expense, host, collective, payoutMethod;

  beforeEach(utils.resetTestDB);
  beforeEach(async () => {
    const transferWiseLibMock = await td.replaceEsm('../../../server/lib/transferwise.js');
    getTransfer = transferWiseLibMock.getTransfer;
    const emailLib = await td.replaceEsm('../../../server/lib/email.js');
    sendMessage = emailLib.default.sendMessage;
    const loggerImport = await td.replaceEsm('../../../server/lib/logger.js');
    logger = loggerImport.default;

    const cron = await import('../../../cron/daily/check-pending-transferwise-transactions.js');
    checkPendingTransfers = cron.run;
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
    td.when(getTransfer(td.matchers.anything(), td.matchers.anything())).thenResolve({
      status: 'outgoing_payment_sent',
      id: 1234,
    });
    await checkPendingTransfers();

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
  });

  it('should ignore expenses manually marked as paid', async () => {
    td.when(getTransfer(td.matchers.anything(), td.matchers.anything())).thenResolve({
      status: 'outgoing_payment_sent',
      id: 1234,
    });
    await fakeExpense({
      status: status.PAID,
      amount: 10000,
      CollectiveId: collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
    });

    await checkPendingTransfers();

    td.verify(logger.info(`Processing expense #${expense.id}...`));
  });

  it('should set expense as error and refund existing transactions when funds are refunded', async () => {
    await expense.update({ status: 'PAID' });
    await fakeTransaction(
      {
        type: 'CREDIT',
        amount: expense.amount,
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
    td.when(getTransfer(td.matchers.anything(), td.matchers.anything())).thenResolve({
      status: 'funds_refunded',
      id: 1234,
    });
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
    td.when(getTransfer(td.matchers.anything(), td.matchers.anything())).thenResolve({
      status: 'funds_refunded',
      id: 1234,
    });

    await checkPendingTransfers();

    await new Promise(resolve => setTimeout(resolve, 15000));

    td.verify(
      sendMessage(expense.User.email, `Payment from ${collective.name} for ${expense.description} expense failed`),
    );
    td.verify(sendMessage(admin.email, `🚨 Transaction failed on ${collective.name}`));
  });
});
