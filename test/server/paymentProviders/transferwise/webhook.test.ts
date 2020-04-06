/* eslint-disable camelcase */

import { expect } from 'chai';
import sinon from 'sinon';
import request from 'supertest';

import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeMember,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import app from '../../../../server/index';
import * as utils from '../../../utils';
import emailLib from '../../../../server/lib/email';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import status from '../../../../server/constants/expense_status';
import { roles } from '../../../../server/constants';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';

describe('paymentMethods/transferwise/webhook.ts', () => {
  const sandbox = sinon.createSandbox();
  const api = request(app) as any;
  /* eslint-disable @typescript-eslint/camelcase */
  const event = {
    data: {
      resource: {
        id: 1234,
        profile_id: 0,
        account_id: 0,
        type: 'transfer',
      },
      current_state: 'outgoing_payment_sent',
      previous_state: 'processing',
      occurred_at: '2020-03-02T13:37:54Z',
    },
    subscription_id: '00000000-0000-0000-0000-000000000000',
    event_type: 'transfers#state-change',
    schema_version: '2.0.0',
    sent_at: '2020-03-02T13:37:54Z',
  };
  let verifyEvent, sendMessage;
  let expense, host, collective;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    verifyEvent = sandbox.stub(transferwiseLib, 'verifyEvent').returns(event);
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
    collective = await fakeCollective({
      HostCollectiveId: host.id,
    });
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
        transfer: { id: event.data.resource.id },
        quote: { fee: 1, rate: 1 },
        fees: {
          hostFeeInHostCurrency: 1,
          platformFeeInHostCurrency: 1,
        },
      },
    });
  });

  it('assigns rawBody to request and verifies the event signature', async () => {
    await api.post('/webhooks/transferwise').send(event).expect(200);

    sinon.assert.calledOnce(verifyEvent);
    const { args } = verifyEvent.getCall(0);
    expect(args[0]).to.have.property('rawBody');
  });

  it('should complete processing transactions if transfer was sent', async () => {
    await api.post('/webhooks/transferwise').send(event).expect(200);

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
  });

  it('should set expense as error and clear existing transactions when funds are refunded', async () => {
    const refundEvent = { ...event, data: { ...event.data, current_state: 'funds_refunded' } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);

    await expense.reload();
    expect(expense).to.have.property('status', status.ERROR);
    const transactions = await expense.getTransactions();
    expect(transactions).to.be.empty;
  });

  it('should send a notification email to the payee and the host when funds are refunded', async () => {
    const admin = await fakeUser({ email: 'admin@oc.com' });
    await fakeMember({ CollectiveId: host.id, MemberCollectiveId: admin.CollectiveId, role: roles.ADMIN });
    const refundEvent = { ...event, data: { ...event.data, current_state: 'funds_refunded' } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);

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

  it('should return 200 OK if the transaction is not associated to any expense', async () => {
    const refundEvent = { ...event, data: { ...event.data, resource: { id: 0 } } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);
  });
});
