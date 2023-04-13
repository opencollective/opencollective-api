/* eslint-disable camelcase */

import { expect } from 'chai';
import { defaultsDeep } from 'lodash';
import { assert, createSandbox } from 'sinon';
import request from 'supertest';

import { roles } from '../../../../server/constants';
import status from '../../../../server/constants/expense_status';
import app from '../../../../server/index';
import emailLib from '../../../../server/lib/email';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeMember,
  fakePayoutMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/transferwise/webhook', () => {
  let expressApp, api;
  before(async () => {
    expressApp = await app();
    api = request(expressApp);
  });

  const sandbox = createSandbox();

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
      HostCollectiveId: host.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
      data: {
        transfer: { id: event.data.resource.id },
        quote: { fee: 10, rate: 1 },
        paymentOption: { fee: { total: 10 }, sourceAmount: 110 },
      },
    });
  });

  it('assigns rawBody to request and verifies the event signature', async () => {
    await api.post('/webhooks/transferwise').send(event).expect(200);

    assert.calledOnce(verifyEvent);
    const { args } = verifyEvent.getCall(0);
    expect(args[0]).to.have.property('rawBody');
  });

  it('should mark expense as paid and create transactions if transfer was sent', async () => {
    await api.post('/webhooks/transferwise').send(event).expect(200);

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
    const [debitTransaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });
    expect(debitTransaction).to.be.have.property('paymentProcessorFeeInHostCurrency', -1000);
    expect(debitTransaction).to.be.have.property('netAmountInCollectiveCurrency', -11000);
    expect(debitTransaction).to.be.have.nested.property('data.transfer.id', 1234);
  });

  it('should ignore payment processor fee if host.settings.transferwise.ignorePaymentProcessorFees is true', async () => {
    await host.update({
      settings: defaultsDeep(host.settings, { transferwise: { ignorePaymentProcessorFees: true } }),
    });

    await api.post('/webhooks/transferwise').send(event).expect(200);
    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);

    const [debitTransaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });
    expect(debitTransaction).to.be.have.property('paymentProcessorFeeInHostCurrency', 0);
    expect(debitTransaction).to.be.have.property('netAmountInCollectiveCurrency', -10000);
  });

  it('should set expense as error when funds are refunded', async () => {
    const refundEvent = { ...event, data: { ...event.data, current_state: 'funds_refunded' } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);

    await expense.reload();
    expect(expense).to.have.property('status', status.ERROR);
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
    expect(sendMessage.args[1][1]).to.contain(`🚨 Transaction failed on ${collective.name}`);
  });

  it('should return 200 OK if the transaction is not associated to any expense', async () => {
    const refundEvent = { ...event, data: { ...event.data, resource: { id: 0 } } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);
  });

  it('works with Expenses with feesPayer = PAYEE', async () => {
    await expense.update({ feesPayer: 'PAYEE' });
    await api.post('/webhooks/transferwise').send(event).expect(200);

    await expense.reload();
    expect(expense).to.have.property('status', status.PAID);
    const [debitTransaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });
    expect(debitTransaction).to.be.have.property('paymentProcessorFeeInHostCurrency', -1000);
    expect(debitTransaction).to.be.have.property('netAmountInCollectiveCurrency', -10000);
    expect(debitTransaction).to.be.have.property('amountInHostCurrency', -11000);
    expect(debitTransaction).to.be.have.property('amount', -11000);
    expect(debitTransaction).to.be.have.nested.property('data.transfer.id', 1234);
  });
});
