import { expect } from 'chai';
import sinon from 'sinon';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import * as LibCurrency from '../../../../server/lib/currency';
import models from '../../../../server/models';
import hostPaymentProvider from '../../../../server/paymentProviders/opencollective/host';
import * as store from '../../../stores';
import * as utils from '../../../utils';

describe('server/paymentProviders/opencollective/host', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  describe('Refunds', () => {
    const HOST_FEE_PERCENT = 10;
    let user, host, collective, hostPaymentMethod;

    /** Create a Host and a hosted Collective. Host uses `hostCurrency`, Collective uses `collectiveCurrency`. */
    const setupHostAndCollective = async (collectiveCurrency, hostCurrency = 'USD') => {
      host = await models.Collective.create({ name: `Host (${hostCurrency})`, currency: hostCurrency, isActive: true });
      user = await models.User.createUserWithCollective({ email: store.randEmail(), name: 'Host Admin' });
      collective = await models.Collective.create({
        name: `hosted-collective-${collectiveCurrency}`,
        currency: collectiveCurrency,
        HostCollectiveId: host.id,
        isActive: true,
        approvedAt: new Date(),
        type: 'COLLECTIVE',
        CreatedByUserId: user.id,
        hostFeePercent: HOST_FEE_PERCENT,
      });
      hostPaymentMethod = await host.getOrCreateHostPaymentMethod();
    };

    const createAddedFundsOrder = async (amount = 5000) => {
      const order = await models.Order.create({
        CreatedByUserId: user.id,
        FromCollectiveId: host.id,
        CollectiveId: collective.id,
        totalAmount: amount,
        currency: collective.currency,
        status: 'PENDING',
        PaymentMethodId: hostPaymentMethod.id,
      });

      order.collective = collective;
      order.fromCollective = host;
      order.createByUser = user;
      order.paymentMethod = hostPaymentMethod;
      return order;
    };

    describe('With a Host in a different currency (split HOST_FEE transactions)', () => {
      let sandbox;

      before(async () => {
        sandbox = sinon.createSandbox();
        sandbox.stub(LibCurrency, 'getFxRate').callsFake((fromCurrency, toCurrency) => {
          if (fromCurrency === toCurrency) {
            return Promise.resolve(1);
          } else if (fromCurrency === 'EUR' && toCurrency === 'USD') {
            return Promise.resolve(1.1);
          } else if (fromCurrency === 'USD' && toCurrency === 'EUR') {
            return Promise.resolve(1 / 1.1);
          }
          throw new Error(`Unexpected getFxRate call: ${fromCurrency} -> ${toCurrency}`);
        });
      });

      after(() => {
        sandbox.restore();
      });

      beforeEach(async () => {
        // Host is in USD, the hosted Collective is in EUR
        await setupHostAndCollective('EUR');
      });

      it('Converts amounts to the Host currency and splits the Host Fee into its own transaction', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});

        // Main ADDED_FUNDS transaction: kept in the Collective's currency, converted to the Host's currency
        expect(transaction.type).to.equal('CREDIT');
        expect(transaction.kind).to.equal(TransactionKind.ADDED_FUNDS);
        expect(transaction.currency).to.equal('EUR');
        expect(transaction.hostCurrency).to.equal('USD');
        expect(transaction.hostCurrencyFxRate).to.equal(1.1);
        expect(transaction.amount).to.equal(5000);
        expect(transaction.amountInHostCurrency).to.equal(5500);
        expect(transaction.HostCollectiveId).to.equal(host.id);
        expect(transaction.FromCollectiveId).to.equal(host.id);
        expect(transaction.CollectiveId).to.equal(collective.id);
        // The Host Fee is no longer stored on the main transaction, it's a separate one now
        expect(transaction.hostFeeInHostCurrency).to.equal(0);

        // The Host Fee should have been split into its own transaction, converted to the Host's currency
        const hostFeeCredit = await transaction.getHostFeeTransaction();
        expect(hostFeeCredit).to.exist;
        expect(hostFeeCredit.type).to.equal('CREDIT');
        expect(hostFeeCredit.FromCollectiveId).to.equal(collective.id);
        expect(hostFeeCredit.CollectiveId).to.equal(host.id);
        expect(hostFeeCredit.currency).to.equal('EUR');
        expect(hostFeeCredit.hostCurrency).to.equal('USD');
        expect(hostFeeCredit.amount).to.equal(500); // 10% of 5000 EUR
        expect(hostFeeCredit.amountInHostCurrency).to.equal(550); // 500 EUR * 1.1

        // The Collective's balance (in the Host's currency) reflects the added funds minus the Host Fee
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4950);
      });

      it('Refunds the added funds and the split Host Fee transaction', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4950);

        const updatedTransaction = await hostPaymentProvider.refundTransaction(transaction, user);
        expect(updatedTransaction.RefundTransactionId).to.exist;

        // Balance should be back to zero
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(0);

        // The refund transaction mirrors the original added funds, in the Host's currency
        const refundTransaction = await models.Transaction.findByPk(updatedTransaction.RefundTransactionId);
        expect(refundTransaction.type).to.equal('DEBIT');
        expect(refundTransaction.kind).to.equal(TransactionKind.ADDED_FUNDS);
        expect(refundTransaction.currency).to.equal('EUR');
        expect(refundTransaction.hostCurrency).to.equal('USD');
        expect(refundTransaction.amount).to.equal(-5000);
        expect(refundTransaction.amountInHostCurrency).to.equal(-5500);

        // The split Host Fee transaction should also have been refunded
        const refundedHostFeeTransactions = await models.Transaction.findAll({
          where: { TransactionGroup: refundTransaction.TransactionGroup, kind: TransactionKind.HOST_FEE },
        });
        expect(refundedHostFeeTransactions).to.have.length(2); // CREDIT + DEBIT
        const refundedHostFeeCredit = refundedHostFeeTransactions.find(t => t.type === 'CREDIT');
        expect(refundedHostFeeCredit.FromCollectiveId).to.equal(host.id);
        expect(refundedHostFeeCredit.CollectiveId).to.equal(collective.id);
        expect(refundedHostFeeCredit.amountInHostCurrency).to.equal(550);
      });

      it('Cannot refund if the Host currency balance is not enough, even with split transactions', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4950);

        // Simulate the Collective having spent most of its balance elsewhere (e.g. paying an expense)
        const payee = await models.Collective.create({ name: 'payee', currency: 'EUR', isActive: true });
        await models.Transaction.create({
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          FromCollectiveId: payee.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          amount: -4000,
          netAmountInCollectiveCurrency: -4000,
          currency: 'EUR',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1.1,
          amountInHostCurrency: -4400,
          CreatedByUserId: user.id,
          TransactionGroup: '00000000-0000-0000-0000-000000000000',
        });
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(550); // 4950 - (4000 * 1.1)

        await expect(hostPaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
          'Not enough funds available ($5.50 left) to process this refund ($49.50)',
        );
      });
    });

    describe('With a Host in the same currency (split HOST_FEE transactions)', () => {
      beforeEach(async () => {
        // Host and hosted Collective are both in USD
        await setupHostAndCollective('USD');
      });

      it('Splits the Host Fee into its own transaction without any currency conversion', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});

        // Main ADDED_FUNDS transaction: same currency everywhere, no conversion
        expect(transaction.type).to.equal('CREDIT');
        expect(transaction.kind).to.equal(TransactionKind.ADDED_FUNDS);
        expect(transaction.currency).to.equal('USD');
        expect(transaction.hostCurrency).to.equal('USD');
        expect(transaction.hostCurrencyFxRate).to.equal(1);
        expect(transaction.amount).to.equal(5000);
        expect(transaction.amountInHostCurrency).to.equal(5000);
        expect(transaction.HostCollectiveId).to.equal(host.id);
        expect(transaction.FromCollectiveId).to.equal(host.id);
        expect(transaction.CollectiveId).to.equal(collective.id);
        // The Host Fee is no longer stored on the main transaction, it's a separate one now
        expect(transaction.hostFeeInHostCurrency).to.equal(0);

        // The Host Fee should have been split into its own transaction, in the same currency
        const hostFeeCredit = await transaction.getHostFeeTransaction();
        expect(hostFeeCredit).to.exist;
        expect(hostFeeCredit.type).to.equal('CREDIT');
        expect(hostFeeCredit.FromCollectiveId).to.equal(collective.id);
        expect(hostFeeCredit.CollectiveId).to.equal(host.id);
        expect(hostFeeCredit.currency).to.equal('USD');
        expect(hostFeeCredit.hostCurrency).to.equal('USD');
        expect(hostFeeCredit.amount).to.equal(500); // 10% of 5000
        expect(hostFeeCredit.amountInHostCurrency).to.equal(500);

        // The Collective's balance reflects the added funds minus the Host Fee
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4500);
      });

      it('Refunds the added funds and the split Host Fee transaction', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4500);

        const updatedTransaction = await hostPaymentProvider.refundTransaction(transaction, user);
        expect(updatedTransaction.RefundTransactionId).to.exist;

        // Balance should be back to zero
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(0);

        // The refund transaction mirrors the original added funds
        const refundTransaction = await models.Transaction.findByPk(updatedTransaction.RefundTransactionId);
        expect(refundTransaction.type).to.equal('DEBIT');
        expect(refundTransaction.kind).to.equal(TransactionKind.ADDED_FUNDS);
        expect(refundTransaction.currency).to.equal('USD');
        expect(refundTransaction.hostCurrency).to.equal('USD');
        expect(refundTransaction.amount).to.equal(-5000);
        expect(refundTransaction.amountInHostCurrency).to.equal(-5000);

        // The split Host Fee transaction should also have been refunded
        const refundedHostFeeTransactions = await models.Transaction.findAll({
          where: { TransactionGroup: refundTransaction.TransactionGroup, kind: TransactionKind.HOST_FEE },
        });
        expect(refundedHostFeeTransactions).to.have.length(2); // CREDIT + DEBIT
        const refundedHostFeeCredit = refundedHostFeeTransactions.find(t => t.type === 'CREDIT');
        expect(refundedHostFeeCredit.FromCollectiveId).to.equal(host.id);
        expect(refundedHostFeeCredit.CollectiveId).to.equal(collective.id);
        expect(refundedHostFeeCredit.amountInHostCurrency).to.equal(500);
      });

      it('Cannot refund if the balance is not enough, even with split transactions', async () => {
        const order = await createAddedFundsOrder();
        const transaction = await hostPaymentProvider.processOrder(order, {});
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(4500);

        // Simulate the Collective having spent most of its balance elsewhere (e.g. paying an expense)
        const payee = await models.Collective.create({ name: 'payee', currency: 'USD', isActive: true });
        await models.Transaction.create({
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          FromCollectiveId: payee.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          amount: -4000,
          netAmountInCollectiveCurrency: -4000,
          currency: 'USD',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1,
          amountInHostCurrency: -4000,
          CreatedByUserId: user.id,
          TransactionGroup: '00000000-0000-0000-0000-000000000000',
        });
        expect(await collective.getBalance({ currency: 'USD' })).to.equal(500); // 4500 - 4000

        await expect(hostPaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
          'Not enough funds available ($5.00 left) to process this refund ($45.00)',
        );
      });
    });
  });
});
