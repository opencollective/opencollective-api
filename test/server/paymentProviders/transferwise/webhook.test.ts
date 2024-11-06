/* eslint-disable camelcase */

import { expect } from 'chai';
import config from 'config';
import { defaultsDeep } from 'lodash';
import { assert, createSandbox } from 'sinon';
import request from 'supertest';

import { roles } from '../../../../server/constants';
import { SupportedCurrency } from '../../../../server/constants/currencies';
import status from '../../../../server/constants/expense-status';
import app from '../../../../server/index';
import { getFxRate } from '../../../../server/lib/currency';
import emailLib from '../../../../server/lib/email';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import models from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import { handleTransferStateChange } from '../../../../server/paymentProviders/transferwise/webhook';
import { TransferRefundEvent } from '../../../../server/types/transferwise';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeMember,
  fakePayoutMethod,
  fakeUser,
  randNumber,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const RATES = {
  USD: { EUR: 0.84, JPY: 110.94 },
  EUR: { USD: 1.19, JPY: 132.45 },
  JPY: { EUR: 0.0075, USD: 0.009 },
};

describe('server/paymentProviders/transferwise/webhook', () => {
  let expressApp, api;
  before(async () => {
    expressApp = await app();
    api = request(expressApp);
    utils.nockFixerRates(RATES);
  });

  const sandbox = createSandbox();
  afterEach(sandbox.restore);

  describe('handleTransferStateChange', () => {
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

    beforeEach(utils.resetTestDB);
    beforeEach(() => {
      verifyEvent = sandbox
        .stub(transferwiseLib, 'getToken')
        .callsFake(async connectedAccount => connectedAccount.token);
      verifyEvent = sandbox.stub(transferwiseLib, 'getTransfer').resolves({ id: event.data.resource.id });
      verifyEvent = sandbox.stub(transferwiseLib, 'verifyEvent').returns(event);
      sendMessage = sandbox.spy(emailLib, 'sendMessage');
      sandbox
        .stub(transferwiseLib, 'getQuote')
        .resolves({ paymentOptions: [{ fee: { total: 10 }, sourceAmount: 110 }] });
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
          id: 123,
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
          recipient: payoutMethod.data,
          transfer: { id: event.data.resource.id },
          quote: { fee: 10, rate: 1, targetAccount: 123 },
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

    it('should set expense as error when the transfer fails', async () => {
      const refundEvent = { ...event, data: { ...event.data, current_state: 'cancelled' } };
      verifyEvent.returns(refundEvent);

      await api.post('/webhooks/transferwise').send(event).expect(200);

      await expense.reload();
      expect(expense).to.have.property('status', status.ERROR);
    });

    it('should send a notification email to the payee and the host when the transfer fails', async () => {
      const admin = await fakeUser({ email: 'admin@oc.com' });
      await fakeMember({ CollectiveId: host.id, MemberCollectiveId: admin.CollectiveId, role: roles.ADMIN });
      const refundEvent = { ...event, data: { ...event.data, current_state: 'cancelled' } };
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
      await expense.update({
        feesPayer: 'PAYEE',
        data: {
          ...expense.data,
          paymentOption: { fee: { total: 10 }, sourceAmount: 100 },
        },
      });
      await api.post('/webhooks/transferwise').send(event).expect(200);

      await expense.reload();
      expect(expense).to.have.property('status', status.PAID);
      const [debit, credit] = await expense.getTransactions();

      expect(debit).to.have.property('paymentProcessorFeeInHostCurrency', -1000);
      expect(debit).to.have.property('netAmountInCollectiveCurrency', -10000);
      expect(debit).to.have.property('amountInHostCurrency', -9000);
      expect(debit).to.have.property('amount', -9000);
      expect(debit).to.have.nested.property('data.expenseToHostFxRate', 1);
      expect(debit).to.have.nested.property('data.transfer.id', 1234);

      expect(credit).to.have.property('paymentProcessorFeeInHostCurrency', -1000);
      expect(credit).to.have.property('netAmountInCollectiveCurrency', 9000);
      expect(credit).to.have.property('amountInHostCurrency', 10000);
      expect(credit).to.have.property('amount', 10000);
    });
  });

  describe('handleTransferRefund', () => {
    let host, collective, payoutMethod;
    let getTransfer, getQuote, verifyEvent;

    beforeEach(utils.resetTestDB);
    beforeEach(async () => {
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
      sandbox.stub(config, 'transferwise').value({ ...config.transferwise, useTransferRefundHandler: 'true' });
      sandbox.stub(transferwiseLib, 'getToken').callsFake(async connectedAccount => connectedAccount.token);

      getTransfer = sandbox.stub(transferwiseLib, 'getTransfer');
      verifyEvent = sandbox.stub(transferwiseLib, 'verifyEvent');
      getQuote = sandbox.stub(transferwiseLib, 'getQuote');

      await utils.seedDefaultVendors();
      host = await fakeActiveHost({ isHostAccount: true, currency: 'USD', name: 'Fiscal Host' });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        token: '33b5e94d-9815-4ebc-b970-3612b6aec332',
        data: { type: 'business', id: 0 },
      });
      collective = await fakeCollective({
        HostCollectiveId: host.id,
        name: 'Collective',
      });
      payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          id: 123,
          accountHolderName: 'Leo Kewitz',
          currency: 'EUR',
          type: 'iban',
          legalType: 'PRIVATE',
          details: {
            IBAN: 'DE89370400440532013000',
          },
        },
      });
    });

    const setup = async ({
      amount,
      fees,
      refunded,
      collectiveCurrency,
      expense,
      now = '2024-10-11T11:27:11.421Z',
      feesPayer = 'COLLECTIVE',
    }: {
      amount: number;
      fees: number;
      refunded: number;
      collectiveCurrency?: SupportedCurrency;
      expense?: any;
      now?: string;
      feesPayer?: 'COLLECTIVE' | 'PAYEE';
    }) => {
      const transferId = randNumber();
      const hostCurrencyFxRate = await getFxRate(collectiveCurrency || 'USD', 'USD');
      const feesDecimal = (fees / 100) * hostCurrencyFxRate;
      const totalDecimal = ((amount + fees) / 100) * hostCurrencyFxRate;
      const refundedDecimal = (refunded / 100) * hostCurrencyFxRate;

      const event: TransferRefundEvent = {
        data: {
          resource: {
            id: transferId,
            profile_id: 0,
            account_id: 0,
            type: 'transfer',
            refund_amount: refundedDecimal,
            refund_currency: 'USD',
          },
          occurred_at: now,
        },
        subscription_id: '00000000-0000-0000-0000-000000000000',
        event_type: 'transfers#refund',
        schema_version: '2.0.0',
        sent_at: now,
      };

      getTransfer.resolves({ id: transferId, sourceCurrency: 'USD', sourceValue: totalDecimal });
      verifyEvent.returns(event);
      getQuote.resolves({ paymentOptions: [{ fee: { total: feesDecimal }, sourceAmount: totalDecimal }] });

      const user = await fakeUser({
        name: 'User',
      });

      if (expense) {
        await expense.update({
          status: status.PROCESSING,
          feesPayer,
          data: {
            ...expense.data,
            transfer: { id: transferId, sourceCurrency: 'USD', sourceValue: totalDecimal },
            quote: { fee: feesDecimal, rate: 1, targetAccount: 123 },
            paymentOption: { fee: { total: feesDecimal }, sourceAmount: totalDecimal },
          },
        });
      } else {
        expense = await fakeExpense({
          status: status.PROCESSING,
          amount,
          description: 'Invoice',
          CollectiveId: collective.id,
          currency: collectiveCurrency,
          PayoutMethodId: payoutMethod.id,
          FromCollectiveId: user.collective.id,
          HostCollectiveId: host.id,
          type: 'INVOICE',
          feesPayer,
          data: {
            recipient: payoutMethod.data,
            transfer: { id: transferId, sourceCurrency: 'USD', sourceValue: totalDecimal },
            quote: { fee: feesDecimal, rate: 1, targetAccount: 123 },
            paymentOption: { fee: { total: feesDecimal }, sourceAmount: totalDecimal },
          },
        });
      }

      if (collectiveCurrency !== 'USD') {
        await collective.update({ currency: collectiveCurrency });
      }

      return { expense, event };
    };

    describe('Expense was still in PROCESSING (has no Transactions)', () => {
      it('should just mark the Expense as Error if it was fully refunded', async () => {
        const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 11000 });

        await api.post('/webhooks/transferwise').send(event).expect(200);

        await expense.reload({ include: [{ model: models.Transaction }] });

        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);
        expect(expense.Transactions).to.have.length(0);
      });

      it('should create a Payment Processor Fee debit for the difference if partially refunded', async () => {
        const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 10000 });

        await api.post('/webhooks/transferwise').send(event).expect(200);

        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);
        expect(expense.Transactions).to.have.length(2);

        await utils.snapshotLedger([
          'kind',
          'description',
          'type',
          'amount',
          'currency',
          'amountInHostCurrency',
          'hostCurrency',
          'netAmountInCollectiveCurrency',
          'CollectiveId',
          'FromCollectiveId',
          'HostCollectiveId',
          'data.refundWiseEventTimestamp',
        ]);
      });
    });

    describe('Expense was already PAID (has Transactions)', () => {
      it('should fully refund the transactions if refunded amount matches the amount paid', async () => {
        const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 11000 });
        // Pay the Expense
        await handleTransferStateChange({
          data: {
            resource: {
              id: expense.data.transfer.id,
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
        });
        await expense.reload();
        expect(expense).to.have.property('status', status.PAID);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

        // Trigger the Refund event
        await api.post('/webhooks/transferwise').send(event).expect(200);
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

        await utils.snapshotLedger([
          'kind',
          'description',
          'type',
          'amount',
          'currency',
          'amountInHostCurrency',
          'hostCurrency',
          'netAmountInCollectiveCurrency',
          'CollectiveId',
          'FromCollectiveId',
          'HostCollectiveId',
          'data.refundWiseEventTimestamp',
        ]);
      });

      it('should partially refund the transactions if refunded amount is less than the amount paid', async () => {
        const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 10500 });
        // Pay the Expense
        await handleTransferStateChange({
          data: {
            resource: {
              id: expense.data.transfer.id,
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
        });
        await expense.reload();
        expect(expense).to.have.property('status', status.PAID);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

        // Trigger the Refund event
        await api.post('/webhooks/transferwise').send(event).expect(200);
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

        await utils.snapshotLedger([
          'kind',
          'description',
          'type',
          'amount',
          'currency',
          'amountInHostCurrency',
          'hostCurrency',
          'netAmountInCollectiveCurrency',
          'CollectiveId',
          'FromCollectiveId',
          'HostCollectiveId',
          'data.refundWiseEventTimestamp',
        ]);
      });

      describe('feesPayer = PAYEE', () => {
        it('should fully refund the transactions if refunded amount matches the amount paid', async () => {
          const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 11000, feesPayer: 'PAYEE' });
          // Pay the Expense
          await handleTransferStateChange({
            data: {
              resource: {
                id: expense.data.transfer.id,
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
          });
          await expense.reload();
          expect(expense).to.have.property('status', status.PAID);
          expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

          // Trigger the Refund event
          await api.post('/webhooks/transferwise').send(event).expect(200);
          await expense.reload({ include: [{ model: models.Transaction }] });
          expect(expense).to.have.property('status', status.ERROR);
          expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
          expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

          await utils.snapshotLedger([
            'kind',
            'description',
            'type',
            'amount',
            'currency',
            'amountInHostCurrency',
            'hostCurrency',
            'netAmountInCollectiveCurrency',
            'CollectiveId',
            'FromCollectiveId',
            'HostCollectiveId',
            'data.refundWiseEventTimestamp',
          ]);
        });

        it('should partially refund the transactions if refunded amount is less than the amount paid', async () => {
          const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 10500, feesPayer: 'PAYEE' });
          // Pay the Expense
          await handleTransferStateChange({
            data: {
              resource: {
                id: expense.data.transfer.id,
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
          });
          await expense.reload();
          expect(expense).to.have.property('status', status.PAID);
          expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

          // Trigger the Refund event
          await api.post('/webhooks/transferwise').send(event).expect(200);
          await expense.reload({ include: [{ model: models.Transaction }] });
          expect(expense).to.have.property('status', status.ERROR);
          expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
          expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

          await utils.snapshotLedger([
            'kind',
            'description',
            'type',
            'amount',
            'currency',
            'amountInHostCurrency',
            'hostCurrency',
            'netAmountInCollectiveCurrency',
            'CollectiveId',
            'FromCollectiveId',
            'HostCollectiveId',
            'data.refundWiseEventTimestamp',
          ]);
        });
      });

      it('should work with an expense that was paid multiple times', async () => {
        // eslint-disable-next-line prefer-const
        let { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 10500 });
        // Pay the Expense
        await handleTransferStateChange({
          data: {
            resource: {
              id: event.data.resource.id,
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
        });
        await expense.reload();
        expect(expense).to.have.property('status', status.PAID);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

        // Trigger the Refund event
        await api.post('/webhooks/transferwise').send(event).expect(200);
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

        // Second payment Refund
        event = (await setup({ amount: 10100, fees: 1000, refunded: 10600, expense, now: '2024-10-12T00:00:00.000Z' }))
          .event;
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.PROCESSING);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        // Pay the Expense
        await handleTransferStateChange({
          data: {
            resource: {
              id: event.data.resource.id,
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
        });
        await expense.reload();
        expect(expense).to.have.property('status', status.PAID);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

        await api.post('/webhooks/transferwise').send(event).expect(200);
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

        await utils.snapshotLedger([
          'kind',
          'description',
          'type',
          'amount',
          'currency',
          'amountInHostCurrency',
          'hostCurrency',
          'netAmountInCollectiveCurrency',
          'CollectiveId',
          'FromCollectiveId',
          'HostCollectiveId',
          'data.refundWiseEventTimestamp',
        ]);
      });

      it('should work with Collectives that have a different currency than the Host', async () => {
        const { expense, event } = await setup({
          amount: 10000,
          fees: 1000,
          refunded: 10500,
          collectiveCurrency: 'EUR',
        });
        // Pay the Expense
        await handleTransferStateChange({
          data: {
            resource: {
              id: expense.data.transfer.id,
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
        });
        await expense.reload();
        expect(expense).to.have.property('status', status.PAID);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);

        // Trigger the Refund event
        await api.post('/webhooks/transferwise').send(event).expect(200);
        await expense.reload({ include: [{ model: models.Transaction }] });
        expect(expense).to.have.property('status', status.ERROR);
        expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
        expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);

        await utils.snapshotLedger([
          'kind',
          'description',
          'type',
          'amount',
          'currency',
          'amountInHostCurrency',
          'hostCurrency',
          'netAmountInCollectiveCurrency',
          'CollectiveId',
          'FromCollectiveId',
          'HostCollectiveId',
          'data.refundWiseEventTimestamp',
        ]);
      });
    });

    it('should ignore if the Expense was already refunded', async () => {
      const { expense, event } = await setup({ amount: 10000, fees: 1000, refunded: 10000 });

      await api.post('/webhooks/transferwise').send(event).expect(200);
      await api.post('/webhooks/transferwise').send(event).expect(200);

      await expense.reload({ include: [{ model: models.Transaction }] });
      expect(expense).to.have.property('status', status.ERROR);
      expect(expense).to.have.nested.property('data.transfer.id', event.data.resource.id);
      expect(expense).to.have.nested.property('data.refundWiseEventTimestamp', event.data.occurred_at);
      expect(expense.Transactions).to.have.length(2);
    });
  });
});
