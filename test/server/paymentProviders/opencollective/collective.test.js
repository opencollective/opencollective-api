import { expect } from 'chai';
import sinon from 'sinon';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import * as LibCurrency from '../../../../server/lib/currency';
import models from '../../../../server/models';
import collectivePaymentProvider from '../../../../server/paymentProviders/opencollective/collective';
import testPaymentProvider from '../../../../server/paymentProviders/opencollective/test';
import * as store from '../../../stores';
import * as utils from '../../../utils';

describe('server/paymentProviders/opencollective/collective', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  describe('Refunds', () => {
    let user, fromCollective, toCollective, host;

    /** Create an order from `from` to `to` */
    const createOrder = async (from, to, amount = 5000, hostFeePercent = undefined) => {
      const paymentMethod = await models.PaymentMethod.findOne({
        where: { type: 'collective', service: 'opencollective', CollectiveId: from.id },
      });

      const order = await models.Order.create({
        CreatedByUserId: user.id,
        FromCollectiveId: from.id,
        CollectiveId: to.id,
        totalAmount: amount,
        currency: from.currency,
        status: 'PENDING',
        PaymentMethodId: paymentMethod.id,
        data: hostFeePercent === undefined ? undefined : { hostFeePercent },
      });

      // Bind some required properties
      order.collective = to;
      order.fromCollective = from;
      order.createByUser = user;
      order.paymentMethod = paymentMethod;
      return order;
    };

    /** Fund a collective with the test payment provider, which skips balance checks */
    const fundCollective = async (collective, amount = 10000) => {
      const fundingOrder = await models.Order.create({
        CreatedByUserId: user.id,
        FromCollectiveId: host.id,
        CollectiveId: collective.id,
        totalAmount: amount,
        currency: collective.currency,
        status: 'PENDING',
      });
      fundingOrder.collective = collective;
      fundingOrder.fromCollective = host;
      fundingOrder.createByUser = user;
      return testPaymentProvider.processOrder(fundingOrder);
    };

    /** Create a Host and a pair of hosted Collectives. Host uses `hostCurrency`, Collectives use `collectiveCurrency`. */
    const setupHostAndCollectives = async (collectiveCurrency, hostCurrency = 'USD') => {
      host = await models.Collective.create({ name: `Host (${hostCurrency})`, currency: hostCurrency, isActive: true });
      user = await models.User.createUserWithCollective({ email: store.randEmail(), name: 'User' });
      const collectiveParams = {
        currency: collectiveCurrency,
        HostCollectiveId: host.id,
        isActive: true,
        approvedAt: new Date(),
        type: 'COLLECTIVE',
        CreatedByUserId: user.id,
      };
      fromCollective = await models.Collective.create({
        name: `${collectiveCurrency}-collective-1`,
        ...collectiveParams,
      });
      toCollective = await models.Collective.create({
        name: `${collectiveCurrency}-collective-2`,
        ...collectiveParams,
      });
    };

    describe('Without Host Fee', () => {
      const checkBalances = async (expectedFrom, expectedTo) => {
        expect(await fromCollective.getBalance()).to.eq(expectedFrom);
        expect(await toCollective.getBalance()).to.eq(expectedTo);
      };

      before('Create initial data', async () => {
        await setupHostAndCollectives('USD');
      });

      it('Creates the opposite transactions', async () => {
        await checkBalances(0, 0);
        const orderData = await createOrder(fromCollective, toCollective);
        const transaction = await testPaymentProvider.processOrder(orderData);
        await checkBalances(-5000, 5000);

        const refund = await collectivePaymentProvider.refundTransaction(transaction, user);
        await checkBalances(0, 0);

        expect(refund.amount).to.eq(transaction.amount);
        expect(refund.currency).to.eq(transaction.currency);
        expect(refund.platformFeeInHostCurrency).to.eq(0);
        expect(refund.hostFeeInHostCurrency).to.eq(0);
        expect(refund.paymentProcessorFeeInHostCurrency).to.eq(0);
        expect(refund.kind).to.eq(transaction.kind);
      });

      it('Cannot reimburse money if it exceeds the Collective balance', async () => {
        await checkBalances(0, 0);
        const orderData = await createOrder(fromCollective, toCollective);
        const transaction = await testPaymentProvider.processOrder(orderData);
        await checkBalances(-5000, 5000);
        const orderData2 = await createOrder(toCollective, fromCollective, 2500);
        await testPaymentProvider.processOrder(orderData2);
        await checkBalances(-2500, 2500);
        await expect(collectivePaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
          'Not enough funds available ($25.00 left) to process this refund ($50.00)',
        );
      });
    });

    describe('With a Host in a different currency (split HOST_FEE transactions)', () => {
      const HOST_FEE_PERCENT = 10;
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

      // Each test gets its own Host + pair of Collectives so that balances never leak between tests
      beforeEach('Create initial data', async () => {
        // Host is in USD, Collectives are in EUR
        await setupHostAndCollectives('EUR');
      });

      it('Converts amounts to the Host currency and splits the Host Fee into its own transaction', async () => {
        await fundCollective(fromCollective);

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);

        // Main CONTRIBUTION transaction: kept in the Collective's currency, converted to the Host's currency
        expect(transaction.type).to.equal('CREDIT');
        expect(transaction.kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transaction.currency).to.equal('EUR');
        expect(transaction.hostCurrency).to.equal('USD');
        expect(transaction.hostCurrencyFxRate).to.equal(1.1);
        expect(transaction.amount).to.equal(5000);
        expect(transaction.amountInHostCurrency).to.equal(5500);
        expect(transaction.HostCollectiveId).to.equal(host.id);
        expect(transaction.FromCollectiveId).to.equal(fromCollective.id);
        expect(transaction.CollectiveId).to.equal(toCollective.id);
        // The Host Fee is no longer stored on the main transaction, it's a separate one now
        expect(transaction.hostFeeInHostCurrency).to.equal(0);

        // The Host Fee should have been split into its own transaction, converted to the Host's currency
        const hostFeeCredit = await transaction.getHostFeeTransaction();
        expect(hostFeeCredit).to.exist;
        expect(hostFeeCredit.type).to.equal('CREDIT');
        expect(hostFeeCredit.FromCollectiveId).to.equal(toCollective.id);
        expect(hostFeeCredit.CollectiveId).to.equal(host.id);
        expect(hostFeeCredit.currency).to.equal('EUR');
        expect(hostFeeCredit.hostCurrency).to.equal('USD');
        expect(hostFeeCredit.amount).to.equal(500); // 10% of 5000 EUR
        expect(hostFeeCredit.amountInHostCurrency).to.equal(550); // 500 EUR * 1.1

        // toCollective's balance (in the Host's currency) reflects the contribution minus the Host Fee
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4950);
      });

      it('Refunds the contribution and the split Host Fee transaction', async () => {
        await fundCollective(fromCollective);
        const fromCollectiveBalanceAfterFunding = await fromCollective.getBalance({ currency: 'USD' });

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4950);

        const updatedTransaction = await collectivePaymentProvider.refundTransaction(transaction, user);
        expect(updatedTransaction.RefundTransactionId).to.exist;

        // Balance should be back to what it was before the contribution
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(0);
        expect(await fromCollective.getBalance({ currency: 'USD' })).to.equal(fromCollectiveBalanceAfterFunding);

        // The refund transaction mirrors the original contribution, in the Host's currency
        const refundTransaction = await models.Transaction.findByPk(updatedTransaction.RefundTransactionId);
        expect(refundTransaction.type).to.equal('DEBIT');
        expect(refundTransaction.kind).to.equal(TransactionKind.CONTRIBUTION);
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
        expect(refundedHostFeeCredit.CollectiveId).to.equal(toCollective.id);
        expect(refundedHostFeeCredit.amountInHostCurrency).to.equal(550);
      });

      it('Cannot refund if the Host currency balance is not enough, even with split transactions', async () => {
        await fundCollective(fromCollective);

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4950);

        // Send most of toCollective's balance away (no Host Fee on this second transfer)
        const secondOrder = await createOrder(toCollective, fromCollective, 4000, 0);
        await collectivePaymentProvider.processOrder(secondOrder);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(550); // 4950 - (4000 * 1.1)

        await expect(collectivePaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
          'Not enough funds available ($5.50 left) to process this refund ($49.50)',
        );
      });
    });

    describe('With a Host in the same currency (split HOST_FEE transactions)', () => {
      const HOST_FEE_PERCENT = 10;

      // Each test gets its own Host + pair of Collectives so that balances never leak between tests
      beforeEach('Create initial data', async () => {
        // Host and Collectives are all in USD
        await setupHostAndCollectives('USD');
      });

      it('Splits the Host Fee into its own transaction without any currency conversion', async () => {
        await fundCollective(fromCollective);

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);

        // Main CONTRIBUTION transaction: same currency everywhere, no conversion
        expect(transaction.type).to.equal('CREDIT');
        expect(transaction.kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transaction.currency).to.equal('USD');
        expect(transaction.hostCurrency).to.equal('USD');
        expect(transaction.hostCurrencyFxRate).to.equal(1);
        expect(transaction.amount).to.equal(5000);
        expect(transaction.amountInHostCurrency).to.equal(5000);
        expect(transaction.HostCollectiveId).to.equal(host.id);
        expect(transaction.FromCollectiveId).to.equal(fromCollective.id);
        expect(transaction.CollectiveId).to.equal(toCollective.id);
        // The Host Fee is no longer stored on the main transaction, it's a separate one now
        expect(transaction.hostFeeInHostCurrency).to.equal(0);

        // The Host Fee should have been split into its own transaction, in the same currency
        const hostFeeCredit = await transaction.getHostFeeTransaction();
        expect(hostFeeCredit).to.exist;
        expect(hostFeeCredit.type).to.equal('CREDIT');
        expect(hostFeeCredit.FromCollectiveId).to.equal(toCollective.id);
        expect(hostFeeCredit.CollectiveId).to.equal(host.id);
        expect(hostFeeCredit.currency).to.equal('USD');
        expect(hostFeeCredit.hostCurrency).to.equal('USD');
        expect(hostFeeCredit.amount).to.equal(500); // 10% of 5000
        expect(hostFeeCredit.amountInHostCurrency).to.equal(500);

        // toCollective's balance reflects the contribution minus the Host Fee
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4500);
      });

      it('Refunds the contribution and the split Host Fee transaction', async () => {
        await fundCollective(fromCollective);
        const fromCollectiveBalanceAfterFunding = await fromCollective.getBalance({ currency: 'USD' });

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4500);

        const updatedTransaction = await collectivePaymentProvider.refundTransaction(transaction, user);
        expect(updatedTransaction.RefundTransactionId).to.exist;

        // Balance should be back to what it was before the contribution
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(0);
        expect(await fromCollective.getBalance({ currency: 'USD' })).to.equal(fromCollectiveBalanceAfterFunding);

        // The refund transaction mirrors the original contribution
        const refundTransaction = await models.Transaction.findByPk(updatedTransaction.RefundTransactionId);
        expect(refundTransaction.type).to.equal('DEBIT');
        expect(refundTransaction.kind).to.equal(TransactionKind.CONTRIBUTION);
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
        expect(refundedHostFeeCredit.CollectiveId).to.equal(toCollective.id);
        expect(refundedHostFeeCredit.amountInHostCurrency).to.equal(500);
      });

      it('Cannot refund if the balance is not enough, even with split transactions', async () => {
        await fundCollective(fromCollective);

        const order = await createOrder(fromCollective, toCollective, 5000, HOST_FEE_PERCENT);
        const transaction = await collectivePaymentProvider.processOrder(order);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(4500);

        // Send most of toCollective's balance away (no Host Fee on this second transfer)
        const secondOrder = await createOrder(toCollective, fromCollective, 4000, 0);
        await collectivePaymentProvider.processOrder(secondOrder);
        expect(await toCollective.getBalance({ currency: 'USD' })).to.equal(500); // 4500 - 4000

        await expect(collectivePaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
          'Not enough funds available ($5.00 left) to process this refund ($45.00)',
        );
      });
    });
  });
});
