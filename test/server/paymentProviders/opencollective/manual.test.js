import { expect } from 'chai';
import config from 'config';
import sinon from 'sinon';

import * as LibCurrency from '../../../../server/lib/currency';
import models from '../../../../server/models';
import ManualPaymentMethod from '../../../../server/paymentProviders/opencollective/manual';
import * as store from '../../../stores';
import { seedDefaultVendors } from '../../../utils';

describe('server/paymentProviders/opencollective/manual', () => {
  const hostFeePercent = 5;

  let sandbox, user, host, collective;

  /** Create a test PENDING order from `user` to `collective` */
  const createOrder = async (amount = 5000, collective, options) => {
    const order = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: amount,
      currency: 'USD',
      status: 'PENDING',
      ...options,
    });

    // Bind some required properties
    order.collective = collective;
    order.fromCollective = user.collective;
    order.createByUser = user;
    return order;
  };

  // ---- Setup host, collective and user

  before('Create Host (USD)', async () => {
    host = await models.Collective.create({ name: 'Host 1', currency: 'USD', isActive: true, hostFeePercent });
  });

  before('Create collective', async () => {
    collective = await models.Collective.create({
      name: 'collective1',
      currency: 'USD',
      HostCollectiveId: host.id,
      isActive: true,
      approvedAt: new Date(),
      hostFeePercent,
    });
  });

  before('Create User', async () => {
    user = await models.User.createUserWithCollective({ email: store.randEmail(), name: 'User 1' });
  });

  before('Setup mocks', async () => {
    sandbox = sinon.createSandbox();
    await seedDefaultVendors(); // For eu-vat-tax-vendor
    sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
    sandbox.stub(LibCurrency, 'getFxRate').callsFake((fromCurrency, toCurrency) => {
      if (fromCurrency === toCurrency) {
        return 1;
      } else if (fromCurrency === 'USD' && toCurrency === 'EUR') {
        return 0.9;
      } else if (fromCurrency === 'EUR' && toCurrency === 'USD') {
        return 1.1;
      }
    });
  });

  after(() => {
    sandbox.restore();
  });

  // ---- Test features ----

  describe('Features', () => {
    it("Doesn't support recurring", () => expect(ManualPaymentMethod.features.recurring).to.be.false);
    it("Doesn't charge automatically", () => expect(ManualPaymentMethod.features.waitToCharge).to.be.true);
  });

  // ---- Test processOrder ----

  describe('processOrder', () => {
    it('Returns the CREDIT transaction', async () => {
      const amount = 5000;
      const order = await createOrder(amount, collective);
      const transaction = await ManualPaymentMethod.processOrder(order);

      expect(transaction.type).to.equal('CREDIT');
      expect(transaction.currency).to.equal('USD');
      expect(transaction.hostCurrency).to.equal('USD');
      expect(transaction.OrderId).to.equal(order.id);
      expect(transaction.amount).to.equal(amount);
      expect(transaction.amountInHostCurrency).to.equal(amount);
      expect(transaction.hostFeeInHostCurrency).to.equal(0);
      expect(transaction.platformFeeInHostCurrency).to.equal(0); // We take no fee on manual transactions
      expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0); // We take no fee on manual transactions
      expect(transaction.netAmountInCollectiveCurrency).to.equal(5000);
      expect(transaction.HostCollectiveId).to.equal(host.id);
      expect(transaction.CreatedByUserId).to.equal(user.id);
      expect(transaction.FromCollectiveId).to.equal(user.collective.id);
      expect(transaction.CollectiveId).to.equal(collective.id);
      expect(transaction.PaymentMethodId).to.be.null;
    });

    it("is works if currency doesn't match Host currency", async () => {
      const otherCollective = await models.Collective.create({
        name: 'collective4',
        currency: 'EUR',
        HostCollectiveId: host.id,
        isActive: true,
        hostFeePercent,
      });

      const order = await createOrder(50, otherCollective, {
        currency: 'EUR',
        taxAmount: 10,
        data: {
          hostFeePercent: 10,
          paymentProcessorFee: 10,
          tax: {
            id: 'VAT',
            percentage: 20,
            taxedCountry: 'FR',
            taxerCountry: 'FR',
          },
        },
      });

      const creditTransaction = await ManualPaymentMethod.processOrder(order);
      expect(creditTransaction.currency).to.equal('EUR');
      expect(creditTransaction.hostCurrency).to.equal('USD');
      expect(creditTransaction.hostCurrencyFxRate).to.equal(1.1);
      expect(creditTransaction.amount).to.equal(50);
      expect(creditTransaction.amountInHostCurrency).to.equal(55);
      expect(creditTransaction.hostFeeInHostCurrency).to.equal(0); // Created as separate transaction
      expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(0); // Created as separate transaction
      expect(creditTransaction.taxAmount).to.equal(0); // Created as separate transaction
      expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(50);

      const debitTransaction = await creditTransaction.getOppositeTransaction();
      expect(debitTransaction).to.exist;
      expect(debitTransaction.currency).to.equal('EUR');
      expect(debitTransaction.hostCurrency).to.equal('USD');
      expect(debitTransaction.hostCurrencyFxRate).to.equal(1.1);
      expect(debitTransaction.amount).to.equal(-50);
      expect(debitTransaction.amountInHostCurrency).to.equal(-55);
      expect(debitTransaction.hostFeeInHostCurrency).to.equal(0);
      expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(0);

      const hostFeeCredit = await creditTransaction.getHostFeeTransaction();
      expect(hostFeeCredit).to.exist;
      expect(hostFeeCredit.currency).to.equal('EUR');
      expect(hostFeeCredit.hostCurrency).to.equal('USD');
      expect(hostFeeCredit.hostCurrencyFxRate).to.equal(1.1);
      expect(hostFeeCredit.amount).to.equal(4);
      expect(hostFeeCredit.amountInHostCurrency).to.equal(4); // 4 * 1.1 = 4.4, rounded to 4
      expect(hostFeeCredit.hostFeeInHostCurrency).to.equal(0);
      expect(hostFeeCredit.paymentProcessorFeeInHostCurrency).to.equal(0);

      const hostFeeDebit = await hostFeeCredit.getOppositeTransaction();
      expect(hostFeeDebit).to.exist;
      expect(hostFeeDebit.currency).to.equal('EUR');
      expect(hostFeeDebit.hostCurrency).to.equal('USD');
      expect(hostFeeDebit.hostCurrencyFxRate).to.equal(1.1);
      expect(hostFeeDebit.amount).to.equal(-4);
      expect(hostFeeDebit.amountInHostCurrency).to.equal(-4);
      expect(hostFeeDebit.hostFeeInHostCurrency).to.equal(0);
      expect(hostFeeDebit.paymentProcessorFeeInHostCurrency).to.equal(0);

      const taxCredit = await creditTransaction.getTaxTransaction();
      expect(taxCredit).to.exist;
      expect(taxCredit.currency).to.equal('EUR');
      expect(taxCredit.hostCurrency).to.equal('USD');
      expect(taxCredit.hostCurrencyFxRate).to.equal(1.1);
      expect(taxCredit.amount).to.equal(10);
      expect(taxCredit.amountInHostCurrency).to.equal(11);
      expect(taxCredit.hostFeeInHostCurrency).to.equal(0);
      expect(taxCredit.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(taxCredit.data.tax).to.deep.equal(order.data.tax);

      const taxDebit = await taxCredit.getOppositeTransaction();
      expect(taxDebit).to.exist;
      expect(taxDebit.currency).to.equal('EUR');
      expect(taxDebit.hostCurrency).to.equal('USD');
      expect(taxDebit.hostCurrencyFxRate).to.equal(1.1);
      expect(taxDebit.amount).to.equal(-10);
      expect(taxDebit.amountInHostCurrency).to.equal(-11);
      expect(taxDebit.hostFeeInHostCurrency).to.equal(0);
      expect(taxDebit.paymentProcessorFeeInHostCurrency).to.equal(0);

      const processorFeeCredit = await creditTransaction.getPaymentProcessorFeeTransaction();
      expect(processorFeeCredit).to.exist;
      expect(processorFeeCredit.currency).to.equal('EUR');
      expect(processorFeeCredit.hostCurrency).to.equal('USD');
      expect(processorFeeCredit.hostCurrencyFxRate).to.equal(1.1);
      expect(processorFeeCredit.amount).to.equal(10);
      expect(processorFeeCredit.amountInHostCurrency).to.equal(11);
      expect(processorFeeCredit.hostFeeInHostCurrency).to.equal(0);
      expect(processorFeeCredit.paymentProcessorFeeInHostCurrency).to.equal(0);

      const processorFeeDebit = await processorFeeCredit.getOppositeTransaction();
      expect(processorFeeDebit).to.exist;
      expect(processorFeeDebit.currency).to.equal('EUR');
      expect(processorFeeDebit.hostCurrency).to.equal('USD');
      expect(processorFeeDebit.hostCurrencyFxRate).to.equal(1.1);
      expect(processorFeeDebit.amount).to.equal(-10);
      expect(processorFeeDebit.amountInHostCurrency).to.equal(-11);
      expect(processorFeeDebit.hostFeeInHostCurrency).to.equal(0);
      expect(processorFeeDebit.paymentProcessorFeeInHostCurrency).to.equal(0);
    });
  });

  // ---- refundTransaction ----
  describe('refundTransaction', () => {
    it('Create opposite transactions', async () => {
      const amount = 5000;
      const order = await createOrder(amount, collective);
      const transaction = await ManualPaymentMethod.processOrder(order);

      // Check that the original transaction is correctly updated
      const updatedTransaction = await ManualPaymentMethod.refundTransaction(transaction, user);
      expect(updatedTransaction.RefundTransactionId).to.not.be.null;

      // Check the refund transaction
      const refundTransaction = await models.Transaction.findByPk(updatedTransaction.RefundTransactionId);
      expect(refundTransaction.type).to.equal('DEBIT');
      expect(refundTransaction.currency).to.equal('USD');
      expect(refundTransaction.hostCurrency).to.equal('USD');
      expect(refundTransaction.OrderId).to.equal(order.id);
      expect(refundTransaction.amount).to.equal(-amount);
      expect(refundTransaction.amountInHostCurrency).to.equal(-amount);
      expect(refundTransaction.hostFeeInHostCurrency).to.equal(0);
      expect(refundTransaction.platformFeeInHostCurrency).to.equal(0); // We take no fee on manual refundTransactions
      expect(refundTransaction.paymentProcessorFeeInHostCurrency).to.equal(0); // We take no fee on manual refundTransactions
      expect(refundTransaction.netAmountInCollectiveCurrency).to.equal(-5000);
      expect(refundTransaction.HostCollectiveId).to.equal(host.id);
      expect(refundTransaction.CreatedByUserId).to.equal(user.id);
      expect(refundTransaction.FromCollectiveId).to.equal(user.collective.id);
      expect(refundTransaction.CollectiveId).to.equal(collective.id);
      expect(refundTransaction.PaymentMethodId).to.be.null;
      expect(refundTransaction.kind).to.eq(transaction.kind);
    });
  });
});
