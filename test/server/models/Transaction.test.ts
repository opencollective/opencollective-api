import { expect } from 'chai';
import config from 'config';
import { get } from 'lodash';
import type { Order } from 'sequelize';
import { createSandbox } from 'sinon';
import type Stripe from 'stripe';

import { activities } from '../../../server/constants';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import * as LibActivities from '../../../server/lib/activities';
import { createRefundTransaction } from '../../../server/lib/payments';
import { getHostPlatformTipsAccount } from '../../../server/lib/transactions';
import type { Transaction as TransactionModel } from '../../../server/models';
import models, { Op } from '../../../server/models';

type TransactionPayload = Partial<TransactionModel> & { totalAmount?: number; platformTipAmount?: number };
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { Transaction } = models;

const transactionsData = utils.data('transactions1').transactions;

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'netAmountInCollectiveCurrency',
  'currency',
  'HostCollectiveId',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'taxAmount',
  'amount',
  'description',
];

const SNAPSHOT_COLUMNS_WITH_DEBT = [
  'kind',
  'type',
  'isDebt',
  'FromCollectiveId',
  'CollectiveId',
  'HostCollectiveId',
  'amount',
  'currency',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'settlementStatus',
  'description',
];

describe('server/models/Transaction', () => {
  let sandbox, user, host, inc, collective, defaultTransactionData;

  beforeEach(async () => {
    await utils.resetTestDB();

    await utils.seedDefaultVendors();
    sandbox = createSandbox();
    user = await fakeUser({}, { name: 'User' });
    inc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      name: 'Open Collective',
      CreatedByUserId: user.id,
      HostCollectiveId: PlatformConstants.PlatformCollectiveId,
    });
    host = await fakeHost({
      name: 'Random Host',
      CreatedByUserId: user.id,
    });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      CreatedByUserId: user.id,
      name: 'Collective',
    });
    defaultTransactionData = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
  });

  afterEach(() => {
    sandbox.restore();
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

  it('createFromContributionPayload creates a double entry transaction for a Stripe payment in EUR with VAT', () => {
    const transactionPayload: TransactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
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
      type: TransactionTypes.CREDIT,
      createdAt: new Date('2015-05-29T07:00:00.000Z'),
      PaymentMethodId: 1,
    };

    return Transaction.createFromContributionPayload(transactionPayload).then(() => {
      return Transaction.findAll({ order: [['id', 'ASC']] }).then(transactions => {
        utils.snapshotTransactions(transactions, { columns: SNAPSHOT_COLUMNS });

        expect(transactions.length).to.equal(4);

        const contributions = transactions.filter(t => t.kind === TransactionKind.CONTRIBUTION);

        expect(contributions.length).to.equal(2);
        expect(contributions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[0].type).to.equal('DEBIT');
        expect(contributions[0].netAmountInCollectiveCurrency).to.equal(-12100);
        expect(contributions[0].currency).to.equal('EUR');
        expect(contributions[0].HostCollectiveId).to.be.null;

        expect(contributions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[1].type).to.equal('CREDIT');
        expect(contributions[1].amount).to.equal(12100);
        expect(contributions[1].platformFeeInHostCurrency).to.equal(-500);
        expect(contributions[1].hostFeeInHostCurrency).to.equal(0);
        expect(contributions[1].paymentProcessorFeeInHostCurrency).to.equal(-300);
        expect(contributions[1].taxAmount).to.equal(-2100);
        expect(contributions[1].amount).to.equal(12100);
        expect(contributions[1].netAmountInCollectiveCurrency).to.equal(9200);
        expect(contributions[0] instanceof models.Transaction).to.be.true;
        expect(contributions[0].description).to.equal(transactionPayload.description);
      });
    });
  });

  it('createFromContributionPayload creates a double entry transaction for a Stripe donation in EUR on a USD host', () => {
    const transactionPayload: TransactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      description: '€100 donation to WWCode Berlin',
      amount: 10000,
      amountInHostCurrency: 11000,
      currency: 'EUR',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1.1,
      platformFeeInHostCurrency: 550,
      hostFeeInHostCurrency: 550,
      paymentProcessorFeeInHostCurrency: 330,
      type: TransactionTypes.CREDIT,
      createdAt: new Date('2015-05-29T07:00:00.000Z'),
      PaymentMethodId: 1,
    };

    return Transaction.createFromContributionPayload(transactionPayload).then(() => {
      return Transaction.findAll({ order: [['id', 'asc']] }).then(transactions => {
        expect(transactions.length).to.equal(4);

        const contributions = transactions.filter(t => t.kind === TransactionKind.CONTRIBUTION);

        expect(contributions.length).to.equal(2);
        expect(contributions[0] instanceof models.Transaction).to.be.true;
        expect(contributions[0].type).to.equal('DEBIT');
        expect(contributions[0].netAmountInCollectiveCurrency).to.equal(-10000);
        expect(contributions[0].currency).to.equal('EUR');
        expect(contributions[0].HostCollectiveId).to.be.null;
        expect(contributions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[0].description).to.equal(transactionPayload.description);

        expect(contributions[1].type).to.equal('CREDIT');
        expect(contributions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[1].amount).to.equal(10000);
        expect(contributions[1].platformFeeInHostCurrency).to.equal(-550);
        expect(contributions[1].hostFeeInHostCurrency).to.equal(0);
        expect(contributions[1].paymentProcessorFeeInHostCurrency).to.equal(-330);
        expect(contributions[1].taxAmount).to.be.null;
        expect(contributions[1].amount).to.equal(10000);
        expect(contributions[1].netAmountInCollectiveCurrency).to.equal(9200);
      });
    });
  });

  it('createFromContributionPayload() generates a new activity for allowed collectives', async () => {
    sandbox.stub(LibActivities, 'shouldGenerateTransactionActivities').returns(true);
    const createActivityStub = sandbox.stub(Transaction, 'createActivity');

    const transaction = await Transaction.createFromContributionPayload({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      ...transactionsData[7],
      description: randStr(),
    });

    await utils.waitForCondition(() => createActivityStub.called);
    expect(createActivityStub.firstCall.args[0].description).to.equal(transaction.description);
  });

  it('createFromContributionPayload() persists a collective.transaction.created activity record', async () => {
    sandbox.stub(LibActivities, 'shouldGenerateTransactionActivities').returns(true);

    const description = randStr('contribution-');
    const transactionPayload: TransactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      ...transactionsData[7],
      description,
      amountInHostCurrency: transactionsData[7].amount,
      hostCurrency: transactionsData[7].currency,
      hostCurrencyFxRate: 1,
      hostFeeInHostCurrency: 0,
      platformFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: 0,
      type: TransactionTypes.CREDIT,
      kind: TransactionKind.CONTRIBUTION,
    };

    // createFromContributionPayload ultimately calls createDoubleEntry inside a SQL transaction.
    const creditTransaction = await Transaction.createFromContributionPayload(transactionPayload);

    const transactionsInGroup = await Transaction.findAll({
      where: { TransactionGroup: creditTransaction.TransactionGroup, kind: TransactionKind.CONTRIBUTION },
    });
    expect(transactionsInGroup).to.have.length(2);

    await utils.waitForCondition(async () => {
      const activityCount = await models.Activity.count({
        where: {
          type: activities.COLLECTIVE_TRANSACTION_CREATED,
          TransactionId: { [Op.in]: transactionsInGroup.map(t => t.id) },
        },
      });
      return activityCount === transactionsInGroup.length;
    });

    const transactionActivities = await models.Activity.findAll({
      where: {
        type: activities.COLLECTIVE_TRANSACTION_CREATED,
        TransactionId: { [Op.in]: transactionsInGroup.map(t => t.id) },
      },
    });

    expect(transactionActivities, 'expected activities to be persisted for each ledger entry').to.have.length(2);
    const creditActivity = transactionActivities.find(activity => activity.TransactionId === creditTransaction.id);
    expect(creditActivity).to.exist;
    expect(creditActivity.CollectiveId).to.equal(collective.id);
    expect(creditActivity.data.transaction.description).to.equal(description);
  });

  describe('fees on top', () => {
    it('should deduct the platform fee from the main transactions', async () => {
      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 300,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: 1,
        data: { platformTip: 1000 },
      };

      const t = await Transaction.createFromContributionPayload(transactionPayload);

      expect(t).to.have.property('platformFeeInHostCurrency').equal(0);
      expect(t).to.have.property('kind').equal(TransactionKind.CONTRIBUTION);
      expect(t)
        .to.have.property('netAmountInCollectiveCurrency')
        .equal(
          // The total amount of donation minus the fees on top
          10000 -
            // Minus the payment processor fee
            300,
        );
    });

    it('should create an additional pair of transactions between contributor and Open Collective Inc', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: 1,
        OrderId: order.id,
        data: { platformTip: 1000 },
      };

      const createdTransaction = await Transaction.createFromContributionPayload(transactionPayload);

      // Should have 6 transactions:
      // - 2 for contributions
      // - 2 for platform tip (contributor -> Open Collective)
      // - 2 for platform tip debt (host -> Open Collective)
      const sqlOrder: Order = [['id', 'ASC']];
      const include = [{ association: 'host' }];
      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id }, order: sqlOrder, include });
      await models.TransactionSettlement.attachStatusesToTransactions(allTransactions);
      expect(allTransactions).to.have.length(8);
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS_WITH_DEBT);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS_WITH_DEBT });

      // Check base tip transactions
      const tipCredit = allTransactions.find(t => t.CollectiveId === inc.id && !t.isDebt);
      expect(tipCredit).to.have.property('type').equal('CREDIT');
      expect(tipCredit).to.have.property('amount').equal(1000);
      expect(tipCredit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipCredit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);

      const tipDebit = allTransactions.find(t => t.FromCollectiveId === inc.id && !t.isDebt);
      expect(tipDebit).to.have.property('type').equal('DEBIT');
      expect(tipDebit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipDebit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);
      expect(tipDebit).to.have.property('amount').equal(-1000);

      // Check tip DEBT transactions
      const tipDebtCredit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      const tipDebtDebit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      expect(tipDebtCredit).to.exist;
      expect(tipDebtDebit).to.exist;

      // Check settlement
      const settlement = await models.TransactionSettlement.getByTransaction(tipDebtCredit);
      expect(settlement).to.exist;
      expect(settlement.status).to.eq('OWED');
    });

    it('rejects a negative platform tip payload instead of writing a reversed entry', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 10000,
        amountInHostCurrency: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: 1,
        OrderId: order.id,
        data: { platformTip: -100 },
      };

      await expect(Transaction.createFromContributionPayload(transactionPayload)).to.be.rejectedWith(
        'Platform tip amount cannot be negative',
      );
    });

    it('should convert the donation transaction to USD and store the FX rate', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: 1,
        OrderId: order.id,
        data: { platformTip: 1000 },
      };

      await Transaction.createFromContributionPayload(transactionPayload);

      const allTransactions = await Transaction.findAll({
        where: { OrderId: order.id },
        order: [['id', 'asc']],
      });
      expect(allTransactions).to.have.length(8);

      const donationCredit = allTransactions.find(t => t.CollectiveId === inc.id);
      expect(donationCredit).to.have.property('type').equal('CREDIT');
      expect(donationCredit).to.have.property('currency').equal('EUR');
      expect(donationCredit).to.have.property('hostCurrency').equal('USD');
      expect(donationCredit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationCredit).to.have.property('amount').equal(Math.round(1000));
      expect(donationCredit)
        .to.have.property('amountInHostCurrency')
        .equal(Math.round(1000 * donationCredit.data.hostToPlatformFxRate));

      const donationDebit = allTransactions.find(t => t.FromCollectiveId === inc.id);
      expect(donationDebit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationDebit).to.have.property('type').equal('DEBIT');
      expect(donationDebit).to.have.property('currency').equal('EUR');
      expect(donationDebit).to.have.property('hostCurrency').equal('USD');
      expect(donationDebit).to.have.property('amount').equal(-1000);
      expect(donationDebit)
        .to.have.property('amountInHostCurrency')
        .equal(Math.round(-1000 * donationDebit.data.hostToPlatformFxRate));
    });

    describe('NEW_PLATFORM_TIPS_LEDGER feature', () => {
      beforeEach(async () => {
        await host.update({ settings: { ...host.settings, newPlatformTipsLedger: true } });
      });

      it('PayPal path: routes PLATFORM_TIP to platform-tips account and writes no PLATFORM_TIP_DEBT', async () => {
        const order = await fakeOrder({
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
        });

        const transactionPayload: TransactionPayload = {
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          description: '$100 PayPal donation + $10 tip',
          amount: 11000,
          totalAmount: 11000,
          amountInHostCurrency: 11000,
          currency: 'USD',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1,
          hostFeeInHostCurrency: 500,
          paymentProcessorFeeInHostCurrency: 200,
          type: TransactionTypes.CREDIT,
          createdAt: new Date('2015-05-29T07:00:00.000Z'),
          PaymentMethodId: 1,
          OrderId: order.id,
          // No isPlatformRevenueDirectlyCollected flag: behaves like PayPal
          data: { platformTip: 1000 },
        };

        await Transaction.createFromContributionPayload(transactionPayload);

        const platformTipsAccount = await getHostPlatformTipsAccount(host);
        const allTransactions = await Transaction.findAll({
          where: { OrderId: order.id },
          order: [['id', 'ASC']],
        });
        await models.TransactionSettlement.attachStatusesToTransactions(allTransactions);
        await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS_WITH_DEBT);
        utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS_WITH_DEBT });

        // PLATFORM_TIP credit is on platform-tips account with HostCollectiveId = host.id
        const tipCredit = allTransactions.find(t => t.kind === TransactionKind.PLATFORM_TIP && t.type === 'CREDIT');
        expect(tipCredit, 'PLATFORM_TIP credit').to.exist;
        expect(tipCredit.CollectiveId).to.equal(platformTipsAccount.id);
        expect(tipCredit.HostCollectiveId).to.equal(host.id);
        expect(tipCredit.amount).to.equal(1000);

        // No PLATFORM_TIP_DEBT rows under the new flag
        const debtRows = allTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP_DEBT);
        expect(debtRows, 'no PLATFORM_TIP_DEBT under new flag').to.have.length(0);

        // No APPLICATION_FEE rows for PayPal path
        const appFeeRows = allTransactions.filter(t => t.kind === TransactionKind.APPLICATION_FEE);
        expect(appFeeRows, 'no APPLICATION_FEE for PayPal path').to.have.length(0);
      });

      it('Stripe app-fee path: writes both PLATFORM_TIP and APPLICATION_FEE pair, no PLATFORM_TIP_DEBT', async () => {
        const order = await fakeOrder({
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
        });

        const transactionPayload: TransactionPayload = {
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          description: '$100 Stripe donation + $10 tip via application fee',
          amount: 11000,
          totalAmount: 11000,
          amountInHostCurrency: 11000,
          currency: 'USD',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1,
          hostFeeInHostCurrency: 500,
          paymentProcessorFeeInHostCurrency: 200,
          type: TransactionTypes.CREDIT,
          createdAt: new Date('2015-05-29T07:00:00.000Z'),
          PaymentMethodId: 1,
          OrderId: order.id,
          data: { platformTip: 1000, isPlatformRevenueDirectlyCollected: true },
        };

        await Transaction.createFromContributionPayload(transactionPayload);

        const platformTipsAccount = await getHostPlatformTipsAccount(host);
        const allTransactions = await Transaction.findAll({
          where: { OrderId: order.id },
          order: [['id', 'ASC']],
        });
        await models.TransactionSettlement.attachStatusesToTransactions(allTransactions);
        await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS_WITH_DEBT);
        utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS_WITH_DEBT });

        // PLATFORM_TIP credit on platform-tips account (host-scoped)
        const tipCredit = allTransactions.find(t => t.kind === TransactionKind.PLATFORM_TIP && t.type === 'CREDIT');
        expect(tipCredit, 'PLATFORM_TIP credit').to.exist;
        expect(tipCredit.CollectiveId).to.equal(platformTipsAccount.id);
        expect(tipCredit.HostCollectiveId).to.equal(host.id);

        // APPLICATION_FEE: DEBIT on platform-tips account (host-scoped) + CREDIT on OFiTech
        const appFeeDebit = allTransactions.find(t => t.kind === TransactionKind.APPLICATION_FEE && t.type === 'DEBIT');
        const appFeeCredit = allTransactions.find(
          t => t.kind === TransactionKind.APPLICATION_FEE && t.type === 'CREDIT',
        );
        expect(appFeeDebit, 'APPLICATION_FEE debit').to.exist;
        expect(appFeeDebit.CollectiveId).to.equal(platformTipsAccount.id);
        expect(appFeeDebit.HostCollectiveId).to.equal(host.id);
        expect(appFeeDebit.amount).to.equal(-1000);
        expect(appFeeCredit, 'APPLICATION_FEE credit').to.exist;
        expect(appFeeCredit.CollectiveId).to.equal(inc.id);

        // No PLATFORM_TIP_DEBT rows under the new flag
        const debtRows = allTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP_DEBT);
        expect(debtRows, 'no PLATFORM_TIP_DEBT under new flag').to.have.length(0);
      });
    });

    it('should not create transactions if platformFee is 0', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 10000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: 1,
        OrderId: order.id,
        data: { platformTip: 0 },
      };

      await Transaction.createFromContributionPayload(transactionPayload);

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(4);
    });
  });

  it('should convert properly when using setCurrency', async () => {
    const order = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      currency: 'USD',
    });

    const transactionPayload: TransactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      description: 'Financial contribution to Booky Foundation',
      amount: 500,
      currency: 'USD',
      amountInHostCurrency: 402,
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 0.804,
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: -31,
      type: TransactionTypes.CREDIT,
      PaymentMethodId: 1,
      OrderId: order.id,
      data: {
        charge: { currency: 'usd' } as Stripe.Charge,
        balanceTransaction: {
          currency: 'eur',
          exchange_rate: 0.803246, // eslint-disable-line camelcase
        } as Stripe.BalanceTransaction,
      },
    };

    const credit = await Transaction.createFromContributionPayload(transactionPayload);

    await Transaction.validate(credit);

    await credit.setCurrency('EUR');

    await Transaction.validate(credit);

    expect(credit).to.have.property('currency').equal('EUR');

    expect(credit).to.have.property('amount').equal(402);
  });

  describe('createHostFeeShareTransactions', () => {
    it('applies different host fees share based on the payment method / host plan', async () => {
      await host.update({
        plan: 'default',
        hostFeePercent: 10,
        data: {
          plan: {
            hostFeeSharePercent: 20,
            stripeHostFeeSharePercent: 0,
            paypalHostFeeSharePercent: 0,
          },
        },
      });

      const amount = 1000;

      // Helper to test with a given payment provider
      const testFeesWithPaymentMethod = async (service: PAYMENT_METHOD_SERVICE, type: PAYMENT_METHOD_TYPE) => {
        const paymentMethod = await fakePaymentMethod({ service, type });
        const order = await fakeOrder({
          CollectiveId: collective.id,
          totalAmount: amount,
          PaymentMethodId: paymentMethod.id,
        });
        const transaction = await fakeTransaction({ OrderId: order.id, amount }, { createDoubleEntry: true });
        const hostFeeTransaction: TransactionModel = {
          amountInHostCurrency: amount * 0.1,
          hostCurrency: host.currency,
        } as TransactionModel;
        return Transaction.createHostFeeShareTransactions({ transaction, hostFeeTransaction }, host);
      };

      // Paypal payment
      const paypalResult = await testFeesWithPaymentMethod(PAYMENT_METHOD_SERVICE.PAYPAL, PAYMENT_METHOD_TYPE.PAYMENT);
      expect(paypalResult).to.be.undefined; // no host fee share

      // Stripe
      const stripeResult = await testFeesWithPaymentMethod(
        PAYMENT_METHOD_SERVICE.STRIPE,
        PAYMENT_METHOD_TYPE.CREDITCARD,
      );
      expect(stripeResult).to.be.undefined; // no host fee share

      // Manual
      const manualResult = await testFeesWithPaymentMethod(
        PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        PAYMENT_METHOD_TYPE.MANUAL,
      );
      expect(get(manualResult, 'hostFeeShareTransaction.amount')).to.equal(Math.round(amount * 0.1 * 0.2));
      expect(get(manualResult, 'hostFeeShareDebtTransaction.amount')).to.equal(-Math.round(amount * 0.1 * 0.2));
    });

    it('creates the host fee share and debt when the transaction has no data', async () => {
      await host.update({ data: { hostFeeSharePercent: 15 } });
      const order = await fakeOrder({ CollectiveId: collective.id, totalAmount: 1000, platformTipEligible: false });

      await Transaction.createDoubleEntry({
        ...defaultTransactionData,
        kind: TransactionKind.CONTRIBUTION,
        type: TransactionTypes.CREDIT,
        description: 'Contribution without data',
        amount: 1000,
        amountInHostCurrency: 1000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostFeeInHostCurrency: 100,
        platformFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        OrderId: order.id,
      });

      const hostFeeShareTransactions = await Transaction.findAll({
        where: { OrderId: order.id, kind: TransactionKind.HOST_FEE_SHARE },
      });
      expect(hostFeeShareTransactions).to.have.length(2);
      const hostFeeShareDebtTransactions = await Transaction.findAll({
        where: { OrderId: order.id, kind: TransactionKind.HOST_FEE_SHARE_DEBT },
      });
      expect(hostFeeShareDebtTransactions).to.have.length(2);
    });
  });

  describe('createDoubleEntry', () => {
    it('works an expense that has amount=0 (only payment processor fees)', async () => {
      const result = await models.Transaction.createDoubleEntry({
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.EXPENSE,
        CollectiveId: collective.id,
        FromCollectiveId: user.CollectiveId,
        amount: 0,
        amountInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: -500,
        netAmountInCollectiveCurrency: -500,
        HostCollectiveId: host.id,
      });

      const transactionsPair = await models.Transaction.findAll({
        where: { TransactionGroup: result.TransactionGroup },
      });

      // Creates double entry (credit + debit)
      expect(transactionsPair.length).to.equal(2);
      const credit = transactionsPair.find(t => t.type === 'CREDIT');
      const debit = transactionsPair.find(t => t.type === 'DEBIT');
      expect(credit).to.exist;
      expect(debit).to.exist;

      // Check credit
      expect(credit.CollectiveId).to.equal(user.CollectiveId);
      expect(credit.FromCollectiveId).to.equal(collective.id);
      expect(credit.HostCollectiveId).to.be.null;
      expect(credit.amount).to.equal(500);
      expect(credit.amountInHostCurrency).to.equal(500);
      expect(credit.paymentProcessorFeeInHostCurrency).to.equal(-500);
      expect(credit.netAmountInCollectiveCurrency).to.equal(0);

      // // Check debit
      expect(debit.CollectiveId).to.equal(collective.id);
      expect(debit.FromCollectiveId).to.equal(user.CollectiveId);
      expect(debit.HostCollectiveId).to.equal(host.id);
      expect(debit.amount).to.equal(0);
      expect(debit.amountInHostCurrency).to.equal(0);
      expect(debit.paymentProcessorFeeInHostCurrency).to.equal(-500);
      expect(debit.netAmountInCollectiveCurrency).to.equal(-500);
    });

    describe('opposite side hosted in a zero-decimal currency', () => {
      const USD_TO_KRW = 1346.619822;
      let krwCollective;

      beforeEach(async () => {
        sandbox.stub(Transaction, 'getFxRate').callsFake(async (from, to) => {
          if (from === to) {
            return 1;
          } else if (from === 'USD' && to === 'KRW') {
            return USD_TO_KRW;
          } else if (from === 'KRW' && to === 'USD') {
            return 1 / USD_TO_KRW;
          }
          throw new Error(`Unexpected FX rate request: ${from} -> ${to}`);
        });

        const krwHost = await fakeHost({ currency: 'KRW', CreatedByUserId: user.id });
        // hostFeePercent: 0 to avoid generating cross-host fees for the expense
        krwCollective = await fakeCollective({ HostCollectiveId: krwHost.id, currency: 'KRW', hostFeePercent: 0 });
      });

      const createExpensePair = async (fees: { paymentProcessorFeeInHostCurrency?: number } = {}) => {
        const paymentProcessorFeeInHostCurrency = fees.paymentProcessorFeeInHostCurrency || 0;
        // USD-hosted collective pays an expense to an account hosted in KRW
        const result = await models.Transaction.createDoubleEntry({
          type: TransactionTypes.DEBIT,
          kind: TransactionKind.EXPENSE,
          description: 'Expense paid to a KRW-hosted account',
          CollectiveId: collective.id,
          FromCollectiveId: krwCollective.id,
          HostCollectiveId: host.id,
          currency: 'USD',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1,
          amount: -1000,
          amountInHostCurrency: -1000,
          hostFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency,
          netAmountInCollectiveCurrency: -1000 + paymentProcessorFeeInHostCurrency,
        });

        const transactions = await models.Transaction.findAll({ where: { TransactionGroup: result.TransactionGroup } });
        expect(transactions).to.have.length(2);
        return {
          credit: transactions.find(t => t.type === 'CREDIT'),
          debit: transactions.find(t => t.type === 'DEBIT'),
        };
      };

      it('rounds the opposite transaction amount using its own host currency', async () => {
        const { credit, debit } = await createExpensePair();

        expect(debit.hostCurrency).to.equal('USD');
        expect(debit.amountInHostCurrency).to.equal(-1000);

        expect(credit.CollectiveId).to.equal(krwCollective.id);
        expect(credit.hostCurrency).to.equal('KRW');
        expect(credit.hostCurrencyFxRate).to.equal(USD_TO_KRW);
        // 1000 * 1346.619822 = 1346619.82 -> 1346600 (₩13,466 stored x100). Was 1346620 before the fix.
        expect(credit.amountInHostCurrency).to.equal(1346600);
        expect(credit.amountInHostCurrency % 100).to.equal(0);
        expect(credit.netAmountInHostCurrency % 100).to.equal(0);
      });

      it('rounds the opposite transaction fees using its own host currency', async () => {
        const { credit, debit } = await createExpensePair({ paymentProcessorFeeInHostCurrency: -37 });

        expect(credit.hostCurrency).to.equal('KRW');
        // 1037 * 1346.619822 = 1396444.76 -> 1396400 (was 1396445)
        expect(credit.amountInHostCurrency).to.equal(1396400);
        // -37 * 1346.619822 = -49824.93 -> -49800 (was -49825)
        expect(credit.paymentProcessorFeeInHostCurrency).to.equal(-49800);
        for (const field of ['amountInHostCurrency', 'paymentProcessorFeeInHostCurrency', 'netAmountInHostCurrency']) {
          expect(credit[field] % 100, field).to.equal(0);
        }

        // Validation of the opposite side must agree with the stored rounding
        await Transaction.validate(debit, { oppositeTransaction: credit });
      });
    });
  });

  describe('createTaxTransactions', () => {
    it('gives the tax back to the collective when refunding a contribution with embedded tax', async () => {
      // Legacy contribution, tax embedded in the transaction (taxes not separated yet)
      sandbox.stub(config.ledger, 'separateTaxes').value(false);
      const contribution = await models.Transaction.createDoubleEntry({
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        CreatedByUserId: user.id,
        amount: 1000,
        amountInHostCurrency: 1000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        taxAmount: -200,
        netAmountInCollectiveCurrency: 800,
        description: 'Legacy contribution with embedded tax',
      });
      expect(await collective.getBalance()).to.equal(800);

      // Refund it once taxes are separated
      sandbox.stub(config.ledger, 'separateTaxes').value(true);
      const refundedContribution = await createRefundTransaction(contribution, 0, null, user);
      const refund = await models.Transaction.findByPk(refundedContribution.RefundTransactionId);

      const vendor = await models.Collective.findBySlug('other-tax-vendor');
      const taxTransactions = await models.Transaction.findAll({
        where: { TransactionGroup: refund.TransactionGroup, kind: TransactionKind.TAX },
      });
      expect(taxTransactions).to.have.length(2);
      const taxCredit = taxTransactions.find(t => t.type === TransactionTypes.CREDIT);
      const taxDebit = taxTransactions.find(t => t.type === TransactionTypes.DEBIT);
      expect(taxCredit.CollectiveId).to.equal(collective.id);
      expect(taxCredit.FromCollectiveId).to.equal(vendor.id);
      expect(taxCredit.HostCollectiveId).to.equal(host.id);
      expect(taxCredit.amount).to.equal(200);
      expect(taxDebit.CollectiveId).to.equal(vendor.id);
      expect(taxDebit.amount).to.equal(-200);

      expect(await collective.getBalance()).to.equal(0);
    });
  });

  describe('with separated fees transactions', () => {
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });

    describe('clearedAt date', () => {
      it('automatically populates with the current date', async () => {
        const transaction = await fakeTransaction({ amount: 1000 }, { createDoubleEntry: true });
        expect(transaction.clearedAt).to.be.a('date');
      });

      it('propagates the informed clearedAt date to the related transactions', async () => {
        const order = await fakeOrder({});
        const transaction = await models.Transaction.createFromContributionPayload({
          CreatedByUserId: order.CreatedByUserId,
          FromCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          PaymentMethodId: order.PaymentMethodId,
          type: TransactionTypes.CREDIT,
          OrderId: order.id,
          amount: 5000,
          currency: 'USD',
          hostCurrency: 'USD',
          amountInHostCurrency: 5000,
          hostCurrencyFxRate: 1,
          hostFeeInHostCurrency: 250,
          paymentProcessorFeeInHostCurrency: 175,
          description: 'Monthly subscription to Webpack',
          platformTipAmount: 500,
          clearedAt: new Date('2024-02-20T14:11:00.000Z'),
        } as TransactionPayload);

        const associatedTransactions = await models.Transaction.findAll({
          where: { TransactionGroup: transaction.TransactionGroup },
        });
        expect(associatedTransactions).to.not.be.empty;
        for (const t of associatedTransactions) {
          expect(t.clearedAt.toISOString()).to.equal('2024-02-20T14:11:00.000Z');
        }
      });
    });

    it('does not debit from prepaid-balance if donation is made using Stripe or PayPal', async () => {
      const otherCollective = await fakeCollective({
        HostCollectiveId: host.id,
        CreatedByUserId: user.id,
        name: 'Other Collective',
      });
      const paymentMethod = await fakePaymentMethod({
        CollectiveId: otherCollective.id,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });

      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: otherCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      const transactionPayload: TransactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: otherCollective.id,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 10000,
        amountInHostCurrency: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: TransactionTypes.CREDIT,
        createdAt: new Date('2015-05-29T07:00:00.000Z'),
        PaymentMethodId: paymentMethod.id,
        OrderId: order.id,
        data: { platformTip: 0 },
      };

      await Transaction.createFromContributionPayload(transactionPayload);

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      utils.snapshotTransactions(allTransactions, {
        columns: ['type', 'kind', 'CollectiveId', 'HostCollectiveId', 'amount'],
      });
    });
  });
});
