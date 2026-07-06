import { expect } from 'chai';
import express from 'express';
import { v4 as uuid } from 'uuid';

import { SupportedCurrency } from '../../../../server/constants/currencies';
import PaymentIntentStatus from '../../../../server/constants/payment-intent-status';
import PaymentIntentType from '../../../../server/constants/payment-intent-type';
import { generateConvertToCurrencyLoader } from '../../../../server/graphql/loaders/currency-exchange-rate';
import {
  generatePaymentIntentAmountPledgedLoader,
  generatePaymentIntentAmountReceivedInHostCurrencyLoader,
  generatePaymentIntentAmountSentInHostCurrencyLoader,
  generatePaymentIntentByIdLoader,
  generatePaymentIntentTransactionsLoader,
} from '../../../../server/graphql/loaders/payment-intents';
import models from '../../../../server/models';
import {
  fakeCollective,
  fakeCurrencyExchangeRate,
  fakeExpense,
  fakeOrder,
  fakeTransaction,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const convertLoader = generateConvertToCurrencyLoader();
const mockReq = {
  loaders: {
    CurrencyExchangeRate: {
      convert: convertLoader,
    },
  },
} as express.Request;

const createPaymentIntentWithLedger = async ({
  hostCurrency = 'USD',
  hostCollectiveCurrency = hostCurrency,
  debitAmountInHostCurrency = -5000,
  creditAmountInHostCurrency = 5000,
}: {
  hostCurrency?: SupportedCurrency;
  hostCollectiveCurrency?: SupportedCurrency;
  debitAmountInHostCurrency?: number;
  creditAmountInHostCurrency?: number;
} = {}) => {
  const host = await fakeCollective({ currency: hostCollectiveCurrency });
  const payer = await fakeCollective({ currency: 'USD' });
  const payee = await fakeCollective({ currency: 'EUR' });
  const paymentIntent = await models.PaymentIntent.create({
    status: PaymentIntentStatus.PAID,
    type: PaymentIntentType.Contribution,
    PayerCollectiveId: payer.id,
    PayeeCollectiveId: payee.id,
    HostCollectiveId: host.id,
  });

  const transactionGroup = uuid();
  const debitTx = await fakeTransaction({
    PaymentIntentId: paymentIntent.id,
    type: 'DEBIT',
    CollectiveId: payer.id,
    FromCollectiveId: payee.id,
    amount: debitAmountInHostCurrency,
    amountInHostCurrency: debitAmountInHostCurrency,
    hostCurrency,
    currency: 'USD',
    TransactionGroup: transactionGroup,
  });
  const creditTx = await fakeTransaction({
    PaymentIntentId: paymentIntent.id,
    type: 'CREDIT',
    CollectiveId: payee.id,
    FromCollectiveId: payer.id,
    amount: creditAmountInHostCurrency,
    amountInHostCurrency: creditAmountInHostCurrency,
    hostCurrency,
    currency: 'EUR',
    TransactionGroup: transactionGroup,
  });

  return { paymentIntent, payer, payee, host, debitTx, creditTx };
};

describe('server/graphql/loaders/payment-intents', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('generatePaymentIntentAmountPledgedLoader', () => {
    it('returns the linked order total amount', async () => {
      const order = await fakeOrder({ totalAmount: 7500, currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Contribution,
        OrderId: order.id,
      });

      const amount = await generatePaymentIntentAmountPledgedLoader().load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 7500, currency: 'USD' });
    });

    it('returns the linked expense amount', async () => {
      const expense = await fakeExpense({ amount: 4200, currency: 'EUR' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.PaymentRequest,
        ExpenseId: expense.id,
      });

      const amount = await generatePaymentIntentAmountPledgedLoader().load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 4200, currency: 'EUR' });
    });

    it('prefers the linked order over the linked expense', async () => {
      const order = await fakeOrder({ totalAmount: 1000, currency: 'USD' });
      const expense = await fakeExpense({ amount: 2000, currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Contribution,
        OrderId: order.id,
        ExpenseId: expense.id,
      });

      const amount = await generatePaymentIntentAmountPledgedLoader().load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 1000, currency: 'USD' });
    });

    it('returns null when no order or expense is linked', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Other,
      });

      const amount = await generatePaymentIntentAmountPledgedLoader().load(paymentIntent.id);

      expect(amount).to.be.null;
    });

    it('batch loads multiple payment intents', async () => {
      const order = await fakeOrder({ totalAmount: 1000, currency: 'USD' });
      const expense = await fakeExpense({ amount: 2000, currency: 'EUR' });
      const [withOrder, withExpense] = await Promise.all([
        models.PaymentIntent.create({
          status: PaymentIntentStatus.PENDING,
          type: PaymentIntentType.Contribution,
          OrderId: order.id,
        }),
        models.PaymentIntent.create({
          status: PaymentIntentStatus.PENDING,
          type: PaymentIntentType.PaymentRequest,
          ExpenseId: expense.id,
        }),
      ]);

      const loader = generatePaymentIntentAmountPledgedLoader();
      const [orderAmount, expenseAmount] = await Promise.all([loader.load(withOrder.id), loader.load(withExpense.id)]);

      expect(orderAmount).to.deep.eq({ value: 1000, currency: 'USD' });
      expect(expenseAmount).to.deep.eq({ value: 2000, currency: 'EUR' });
    });
  });

  describe('generatePaymentIntentAmountSentInHostCurrencyLoader', () => {
    it('sums DEBIT transactions for the payer in host currency', async () => {
      const { paymentIntent } = await createPaymentIntentWithLedger();

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('sums net DEBIT amounts in host currency when net is true', async () => {
      const { paymentIntent } = await createPaymentIntentWithLedger({
        debitAmountInHostCurrency: -4500,
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, true).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 4500, currency: 'USD' });
    });

    it('includes host fees in the net amount', async () => {
      const { paymentIntent, payer, payee } = await createPaymentIntentWithLedger({
        debitAmountInHostCurrency: -5000,
      });
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payer.id,
        FromCollectiveId: payee.id,
        amount: 0,
        amountInHostCurrency: 0,
        hostFeeInHostCurrency: -500,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, true).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5500, currency: 'USD' });
    });

    it('sums multiple payer DEBIT transactions', async () => {
      const host = await fakeCollective({ currency: 'USD' });
      const payer = await fakeCollective({ currency: 'USD' });
      const payee = await fakeCollective({ currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Contribution,
        PayerCollectiveId: payer.id,
        PayeeCollectiveId: payee.id,
        HostCollectiveId: host.id,
      });
      const transactionGroup = uuid();

      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payer.id,
        FromCollectiveId: payee.id,
        amount: -2000,
        amountInHostCurrency: -2000,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: transactionGroup,
      });
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payer.id,
        FromCollectiveId: payee.id,
        amount: -3000,
        amountInHostCurrency: -3000,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: transactionGroup,
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('returns null when there is no payer', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Other,
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.be.null;
    });

    it('returns null when there are no matching transactions', async () => {
      const payer = await fakeCollective({ currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Contribution,
        PayerCollectiveId: payer.id,
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.be.null;
    });

    it('ignores DEBIT transactions on other collectives', async () => {
      const { paymentIntent, payee } = await createPaymentIntentWithLedger();
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payee.id,
        FromCollectiveId: payee.id,
        amount: -9999,
        amountInHostCurrency: -9999,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('ignores CREDIT transactions for the payer', async () => {
      const { paymentIntent, payer } = await createPaymentIntentWithLedger();
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'CREDIT',
        CollectiveId: payer.id,
        FromCollectiveId: payer.id,
        amount: 9999,
        amountInHostCurrency: 9999,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('ignores refunded transactions', async () => {
      const { paymentIntent, payer, payee } = await createPaymentIntentWithLedger();
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payer.id,
        FromCollectiveId: payee.id,
        amount: -9999,
        amountInHostCurrency: -9999,
        hostCurrency: 'USD',
        currency: 'USD',
        isRefund: true,
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('converts amounts in other host currencies to the host collective currency', async () => {
      await fakeCurrencyExchangeRate({ from: 'EUR', to: 'USD' });
      const { paymentIntent, payer, payee } = await createPaymentIntentWithLedger();
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'DEBIT',
        CollectiveId: payer.id,
        FromCollectiveId: payee.id,
        amount: -2000,
        amountInHostCurrency: -2000,
        hostCurrency: 'EUR',
        currency: 'EUR',
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountSentInHostCurrencyLoader(mockReq, false).load(paymentIntent.id);

      expect(amount?.currency).to.eq('USD');
      expect(amount?.value).to.be.greaterThan(5000);
    });
  });

  describe('generatePaymentIntentAmountReceivedInHostCurrencyLoader', () => {
    it('sums CREDIT transactions for the payee in host currency', async () => {
      const { paymentIntent } = await createPaymentIntentWithLedger();

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, false).load(
        paymentIntent.id,
      );

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('sums net CREDIT amounts in host currency when net is true', async () => {
      const { paymentIntent } = await createPaymentIntentWithLedger({
        creditAmountInHostCurrency: 4500,
      });

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, true).load(
        paymentIntent.id,
      );

      expect(amount).to.deep.eq({ value: 4500, currency: 'USD' });
    });

    it('returns null when there is no payee', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Other,
      });

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, false).load(
        paymentIntent.id,
      );

      expect(amount).to.be.null;
    });

    it('returns null when there are no matching transactions', async () => {
      const payee = await fakeCollective({ currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.PaymentRequest,
        PayeeCollectiveId: payee.id,
      });

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, false).load(
        paymentIntent.id,
      );

      expect(amount).to.be.null;
    });

    it('ignores CREDIT transactions on other collectives', async () => {
      const { paymentIntent, payer } = await createPaymentIntentWithLedger();
      await fakeTransaction({
        PaymentIntentId: paymentIntent.id,
        type: 'CREDIT',
        CollectiveId: payer.id,
        FromCollectiveId: payer.id,
        amount: 9999,
        amountInHostCurrency: 9999,
        hostCurrency: 'USD',
        currency: 'USD',
        TransactionGroup: uuid(),
      });

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, false).load(
        paymentIntent.id,
      );

      expect(amount).to.deep.eq({ value: 5000, currency: 'USD' });
    });

    it('uses the host collective currency', async () => {
      const { paymentIntent } = await createPaymentIntentWithLedger({
        hostCurrency: 'EUR',
        hostCollectiveCurrency: 'EUR',
        creditAmountInHostCurrency: 3200,
      });

      const amount = await generatePaymentIntentAmountReceivedInHostCurrencyLoader(mockReq, false).load(
        paymentIntent.id,
      );

      expect(amount).to.deep.eq({ value: 3200, currency: 'EUR' });
    });
  });

  describe('generatePaymentIntentTransactionsLoader', () => {
    it('returns linked transactions ordered by id', async () => {
      const { paymentIntent, debitTx, creditTx } = await createPaymentIntentWithLedger();

      const transactions = await generatePaymentIntentTransactionsLoader().load(paymentIntent.id);

      expect(transactions.map(transaction => transaction.id)).to.deep.eq(
        [debitTx.id, creditTx.id].sort((a, b) => a - b),
      );
    });

    it('returns an empty array when there are no linked transactions', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Other,
      });

      const transactions = await generatePaymentIntentTransactionsLoader().load(paymentIntent.id);

      expect(transactions).to.deep.eq([]);
    });
  });

  describe('generatePaymentIntentByIdLoader', () => {
    it('returns the payment intent by id', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Contribution,
      });

      const result = await generatePaymentIntentByIdLoader().load(paymentIntent.id);

      expect(result.id).to.eq(paymentIntent.id);
      expect(result.publicId).to.eq(paymentIntent.publicId);
    });

    it('batch loads payment intents in request order', async () => {
      const [first, second] = await Promise.all([
        models.PaymentIntent.create({
          status: PaymentIntentStatus.PAID,
          type: PaymentIntentType.Contribution,
        }),
        models.PaymentIntent.create({
          status: PaymentIntentStatus.PENDING,
          type: PaymentIntentType.PaymentRequest,
        }),
      ]);

      const loader = generatePaymentIntentByIdLoader();
      const results = await loader.loadMany([second.id, first.id]);

      expect(results.map(result => (result as typeof first).id)).to.deep.eq([second.id, first.id]);
    });
  });
});
