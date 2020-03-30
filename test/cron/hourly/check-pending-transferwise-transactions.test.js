import { expect } from 'chai';
import sinon from 'sinon';

import { run as checkPendingTransfers } from '../../../cron/hourly/check-pending-transferwise-transactions.js';
import { roles } from '../../../server/constants';
import status from '../../../server/constants/expense_status';
import emailLib from '../../../server/lib/email';
import * as transferwiseLib from '../../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeTransaction,
  fakeMember,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/check-pending-transferwise-transactions.js', () => {
  const sandbox = sinon.createSandbox();
  let getTransfer, sendMessage;
  let expense, host, collective;

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
    const payoutMethod = await fakePayoutMethod({
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
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
    });
    await fakeTransaction({
      type: 'DEBIT',
      amount: -1 * expense.amount,
      ExpenseId: expense.id,
      data: {
        transfer: { id: 1234 },
        quote: { fee: 1, rate: 1 },
        fees: { hostFeeInHostCurrency: 1, platformFeeInHostCurrency: 1 },
      },
    });
  });

  it('should complete processing transactions if transfer was sent', async () => {
    getTransfer.resolves({ status: 'outgoing_payment_sent' });
    await checkPendingTransfers();

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
  });

  it('should set expense as error and clear existing transactions when funds are refunded', async () => {
    getTransfer.resolves({ status: 'funds_refunded' });
    await checkPendingTransfers();

    await expense.reload();
    expect(expense).to.have.property('status', status.ERROR);
    const transactions = await expense.getTransactions();
    expect(transactions).to.be.empty;
  });

  it('should send a notification email to the payee and the host when funds are refunded', async () => {
    const admin = await fakeUser({ email: 'admin@oc.com' });
    await fakeMember({ CollectiveId: host.id, MemberCollectiveId: admin.CollectiveId, role: roles.ADMIN });
    getTransfer.resolves({ status: 'funds_refunded' });

    await checkPendingTransfers();

    await utils.waitForCondition(() => sendMessage.callCount === 2);

    expect(sendMessage.args[0][0]).to.equal(expense.User.email);
    expect(sendMessage.args[0][1]).to.contain(
      `Payment from ${collective.name} for ${expense.description} expense failed`,
    );
    expect(sendMessage.args[1][0]).to.equal(admin.email);
    expect(sendMessage.args[1][1]).to.contain(
      `🚨 Transaction failed on ${collective.name}  for ${expense.description}`,
    );
  });
});
