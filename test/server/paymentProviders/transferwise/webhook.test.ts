/* eslint-disable camelcase */

import { expect } from 'chai';
import { defaultsDeep } from 'lodash';
import { assert, createSandbox } from 'sinon';
import request from 'supertest';

import { roles } from '../../../../server/constants';
import status from '../../../../server/constants/expense_status';
import emailLib from '../../../../server/lib/email';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeHost,
  fakeMember,
  fakePayoutMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../../test-helpers/server';
import * as utils from '../../../utils';

describe('server/paymentProviders/transferwise/webhook', () => {
  let expressApp, api, sandbox;

  before(async () => {
    expressApp = await startTestServer();
    api = request(expressApp);
    sandbox = createSandbox();
  });

  after(async () => {
    await stopTestServer();
  });

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
  beforeEach(async () => {
    await utils.resetTestDB();
    verifyEvent = sandbox.stub(transferwiseLib, 'verifyEvent').returns(event);
    sendMessage = sandbox.spy(emailLib, 'sendMessage');
    host = await fakeHost();
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
        transfer: { id: event.data.resource.id, sourceValue: 100 },
        quote: { fee: 1, rate: 1 },
        feesInHostCurrency: {
          hostFeeInHostCurrency: 1,
          platformFeeInHostCurrency: 1,
        },
        paymentOption: { fee: { total: 10 } },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
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
    expect(debitTransaction).to.be.have.property('platformFeeInHostCurrency', -1);
    expect(debitTransaction).to.be.have.property('paymentProcessorFeeInHostCurrency', -1000);
    expect(debitTransaction).to.be.have.property('hostFeeInHostCurrency', -1);
    expect(debitTransaction).to.be.have.property('netAmountInCollectiveCurrency', -11002);
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
    expect(debitTransaction).to.be.have.property('netAmountInCollectiveCurrency', -10002);
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

    // Send an email to the expense creator and the host
    await api.post('/webhooks/transferwise').send(event).expect(200);
    await utils.waitForCondition(() => sendMessage.callCount >= 2, {
      onFailure: () => console.log(sendMessage.callCount, sendMessage.args),
    });

    const expenseCreatorEmail = sendMessage.args.find(args => args[0] === expense.User.email);
    expect(expenseCreatorEmail).to.exist;
    expect(expenseCreatorEmail[1]).to.contain(
      `Payment from ${collective.name} for ${expense.description} expense failed`,
    );

    const hostAdminEmail = sendMessage.args.find(args => args[0] === admin.email);
    expect(hostAdminEmail).to.exist;
    expect(hostAdminEmail[1]).to.contain(`🚨 Transaction failed on ${collective.name}`);
  });

  it('should return 200 OK if the transaction is not associated to any expense', async () => {
    const refundEvent = { ...event, data: { ...event.data, resource: { id: 0 } } };
    verifyEvent.returns(refundEvent);

    await api.post('/webhooks/transferwise').send(event).expect(200);
  });
});
