import { expect } from 'chai';
import sinon from 'sinon';

import models from '../../../server/models';
import { fakeCollective, fakeHost, fakeOrder, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { Transaction } = models;

const transactionsData = utils.data('transactions1').transactions;

describe('server/models/Transaction', () => {
  let user, host, collective, oc, defaultTransactionData;

  beforeEach(() => utils.resetTestDB());

  beforeEach(async () => {
    user = await fakeUser({}, { id: 10 });
    const inc = await fakeHost({ id: 8686, slug: 'opencollectiveinc', CreatedByUserId: user.id });
    oc = await fakeCollective({ id: 1, slug: 'opencollective', CreatedByUserId: user.id, HostCollectiveId: inc.id });
    host = await fakeHost({ id: 2, CreatedByUserId: user.id });
    collective = await fakeCollective({ id: 3, HostCollectiveId: host.id, CreatedByUserId: user.id });
    defaultTransactionData = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
  });

  it('automatically generates uuid', done => {
    Transaction.create({
      amount: -1000,
      ...defaultTransactionData,
    })
      .then(transaction => {
        expect(transaction.info.uuid).to.match(
          /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
        );
        done();
      })
      .catch(done);
  });

  it('get the host', done => {
    Transaction.create({
      ...defaultTransactionData,
      amount: 10000,
    }).then(transaction => {
      expect(transaction.HostCollectiveId).to.equal(host.id);
      done();
    });
  });

  it('createFromPayload creates a double entry transaction for a Stripe payment in EUR with VAT', () => {
    const transaction = {
      description: '€121 for Vegan Burgers including €21 VAT',
      amount: 12100,
      amountInHostCurrency: 12100,
      currency: 'EUR',
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 1,
      platformFeeInHostCurrency: 500,
      hostFeeInHostCurrency: 500,
      paymentProcessorFeeInHostCurrency: 300,
      taxAmount: 2100,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromPayload({
      transaction,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    }).then(() => {
      return Transaction.findAll().then(transactions => {
        expect(transactions.length).to.equal(2);
        expect(transactions[0].type).to.equal('DEBIT');
        expect(transactions[0].netAmountInCollectiveCurrency).to.equal(-12100);
        expect(transactions[0].currency).to.equal('EUR');
        expect(transactions[0].HostCollectiveId).to.be.null;

        expect(transactions[1].type).to.equal('CREDIT');
        expect(transactions[1].amount).to.equal(12100);
        expect(transactions[1].platformFeeInHostCurrency).to.equal(-500);
        expect(transactions[1].paymentProcessorFeeInHostCurrency).to.equal(-300);
        expect(transactions[1].taxAmount).to.equal(-2100);
        expect(transactions[1].amount).to.equal(12100);
        expect(transactions[1].netAmountInCollectiveCurrency).to.equal(8700);
        expect(transactions[0] instanceof models.Transaction).to.be.true;
        expect(transactions[0].description).to.equal(transaction.description);
      });
    });
  });

  it('createFromPayload creates a double entry transaction for a Stripe donation in EUR on a USD host', () => {
    const transaction = {
      description: '€100 donation to WWCode Berlin',
      amount: 10000,
      amountInHostCurrency: 11000,
      currency: 'EUR',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1.1,
      platformFeeInHostCurrency: 550,
      hostFeeInHostCurrency: 550,
      paymentProcessorFeeInHostCurrency: 330,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromPayload({
      transaction,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    }).then(() => {
      return Transaction.findAll().then(transactions => {
        expect(transactions.length).to.equal(2);
        expect(transactions[0].type).to.equal('DEBIT');
        expect(transactions[0].netAmountInCollectiveCurrency).to.equal(-10000);
        expect(transactions[0].currency).to.equal('EUR');
        expect(transactions[0].HostCollectiveId).to.be.null;

        expect(transactions[1].type).to.equal('CREDIT');
        expect(transactions[1].amount).to.equal(10000);
        expect(transactions[1].platformFeeInHostCurrency).to.equal(-550);
        expect(transactions[1].paymentProcessorFeeInHostCurrency).to.equal(-330);
        expect(transactions[1].taxAmount).to.be.null;
        expect(transactions[1].amount).to.equal(10000);
        expect(transactions[1].netAmountInCollectiveCurrency).to.equal(8700);
        expect(transactions[0] instanceof models.Transaction).to.be.true;
        expect(transactions[0].description).to.equal(transaction.description);
      });
    });
  });

  it('createFromPayload() generates a new activity', done => {
    const createActivityStub = sinon.stub(Transaction, 'createActivity').callsFake(t => {
      expect(Math.abs(t.amount)).to.equal(Math.abs(transactionsData[7].netAmountInCollectiveCurrency));
      createActivityStub.restore();
      done();
    });

    Transaction.createFromPayload({
      transaction: transactionsData[7],
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    })
      .then(transaction => {
        expect(transaction.CollectiveId).to.equal(collective.id);
      })
      .catch(done);
  });

  describe('fees on top', () => {
    it('should deduct the platform fee from the main transactions', async () => {
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 10000,
        amountInHostCurrency: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        data: {
          isFeesOnTop: true,
        },
      };

      const t = await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      expect(t).to.have.property('platformFeeInHostCurrency').equal(0);
      expect(t)
        .to.have.property('netAmountInCollectiveCurrency')
        .equal(transaction.amount + transaction.hostFeeInHostCurrency + transaction.paymentProcessorFeeInHostCurrency);
    });

    it('should create an aditional pair of transactions between contributor and Open Collective Inc', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 11000,
        amountInHostCurrency: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(4);

      const donationCredit = allTransactions.find(t => t.CollectiveId === oc.id);
      expect(donationCredit).to.have.property('type').equal('CREDIT');
      expect(donationCredit).to.have.property('amount').equal(1000);

      const donationDebit = allTransactions.find(t => t.FromCollectiveId === oc.id);
      expect(donationDebit).to.have.property('type').equal('DEBIT');
      expect(donationDebit).to.have.property('amount').equal(-1000);
    });

    it('should convert the donation transaction to USD and store the FX rate', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 11000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(4);

      const donationCredit = allTransactions.find(t => t.CollectiveId === oc.id);
      expect(donationCredit).to.have.property('type').equal('CREDIT');
      expect(donationCredit).to.have.property('currency').equal('USD');
      expect(donationCredit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationCredit)
        .to.have.property('amount')
        .equal(Math.round(1000 * donationCredit.data.hostToPlatformFxRate));

      const donationDebit = allTransactions.find(t => t.FromCollectiveId === oc.id);
      expect(donationDebit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationDebit).to.have.property('type').equal('DEBIT');
      expect(donationDebit).to.have.property('currency').equal('USD');
      expect(donationDebit)
        .to.have.property('amount')
        .equal(Math.round(-1000 * donationDebit.data.hostToPlatformFxRate));
    });
  });
});
