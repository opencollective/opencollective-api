/**
 * This test is meant to test the common workflows for the ledger: record a contribution,
 * refund it, add platform tips, etc.
 */

import { expect } from 'chai';
import config from 'config';
import express from 'express';
import { set } from 'lodash';
import moment from 'moment';
import nock from 'nock';
import { createSandbox } from 'sinon';
import Stripe from 'stripe';

import { run as runSettlementScript } from '../../cron/monthly/host-settlement';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import PlatformConstants from '../../server/constants/platform';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { markExpenseAsUnpaid, payExpense } from '../../server/graphql/common/expenses';
import { createRefundTransaction, executeOrder, findPaymentMethodProvider } from '../../server/lib/payments';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import paymentProviders from '../../server/paymentProviders';
import * as webhook from '../../server/paymentProviders/stripe/webhook';
import stripeMocks from '../mocks/stripe';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeOrder,
  fakePayoutMethod,
  fakeUser,
} from '../test-helpers/fake-data';
import { nockFixerRates, resetTestDB, seedDefaultVendors, snapshotLedger } from '../utils';

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'paymentProcessorFeeInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'settlementStatus',
  'isRefund',
  'isDisputed',
];

const SNAPSHOT_COLUMNS_MULTI_CURRENCIES = [
  ...SNAPSHOT_COLUMNS.slice(0, 3),
  'currency',
  'amountInHostCurrency',
  'hostCurrency',
  ...SNAPSHOT_COLUMNS.slice(3),
];

const RATES = {
  USD: { EUR: 0.84, JPY: 110.94 },
  EUR: { USD: 1.19, JPY: 132.45 },
  JPY: { EUR: 0.0075, USD: 0.009 },
};

/**
 * Setup all tests with a similar environment, the only variables being the host/collective currencies
 */
const setupTestData = async (
  hostCurrency,
  collectiveCurrency,
  selfContribution = false,
  contributionFromCollective = false,
) => {
  // TODO: The setup should ideally insert other hosts and transactions to make sure the balance queries are filtering correctly
  await resetTestDB();
  await seedDefaultVendors();
  const hostAdmin = await fakeUser();
  const host = await fakeHost({
    name: 'OSC',
    admin: hostAdmin.collective,
    currency: hostCurrency,
    plan: 'grow-plan-2021', // Use a plan with 15% host share
  });
  await hostAdmin.populateRoles();
  await host.update({ HostCollectiveId: host.id, isActive: true, approvedAt: new Date() });
  const collective = await fakeCollective({
    HostCollectiveId: host.id,
    name: 'ESLint',
    hostFeePercent: 5,
    currency: collectiveCurrency,
  });
  const contributorUser = await fakeUser(undefined, { name: 'Ben' });
  const contributorCollective = await fakeCollective({ name: 'Webpack', HostCollectiveId: host.id });
  const ocInc = await fakeHost({ name: 'OC Inc', id: PlatformConstants.PlatformCollectiveId });
  await fakePayoutMethod({ type: PayoutMethodTypes.OTHER, CollectiveId: ocInc.id }); // For the settlement expense
  await fakePayoutMethod({
    type: PayoutMethodTypes.BANK_ACCOUNT,
    CollectiveId: ocInc.id,
    data: { currency: 'USD' },
    isSaved: true,
  }); // For the settlement expense
  await fakeUser({ id: PlatformConstants.PlatformUserId, name: 'Pia' });
  let FromCollectiveId;
  if (selfContribution) {
    FromCollectiveId = collective.id;
  } else if (contributionFromCollective) {
    FromCollectiveId = contributorCollective.id;
  } else {
    FromCollectiveId = contributorUser.CollectiveId;
  }
  const baseOrderData = {
    description: `Financial contribution to ${collective.name}`,
    totalAmount: 10000,
    currency: collectiveCurrency,
    FromCollectiveId: FromCollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: null,
  };

  return { collective, host, hostAdmin, ocInc, contributorUser, baseOrderData };
};

/**
 * Creates the settlement expenses and pay them
 */
const executeAllSettlement = async remoteUser => {
  await runSettlementScript(moment().add(1, 'month').toDate());
  const settlementExpense = await models.Expense.findOne();
  expect(settlementExpense, 'Settlement expense has not been created').to.exist;
  await settlementExpense.update({ status: 'APPROVED' });
  await payExpense(<express.Request>{ remoteUser }, {
    id: settlementExpense.id,
    forceManual: true,
    totalAmountPaidInHostCurrency: settlementExpense.amount,
  });
};

describe('test/stories/ledger', () => {
  let collective, host, hostAdmin, ocInc, contributorUser, baseOrderData, sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    // Transaction.createActivity is executed async when a transaction is created
    // and due to a race condition with the resetTestDB function it might be
    // executed after the database was cleared, causing a database error.
    sandbox.stub(models.Transaction, 'createActivity').resolves();
    sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Mock currency conversion rates, based on real rates from 2021-06-23
  before(() => {
    nockFixerRates(RATES);
  });

  after(() => {
    nock.cleanAll();
  });

  /** Check the validity of all transactions created during tests */
  afterEach(async () => {
    const transactions = await models.Transaction.findAll({ order: [['id', 'DESC']] });
    await Promise.all(
      transactions.map(transaction => models.Transaction.validate(transaction, { validateOppositeTransaction: true })),
    );
  });

  describe('Level 1: Same currency (USD)', () => {
    beforeEach(async () => {
      ({ collective, host, hostAdmin, ocInc, contributorUser, baseOrderData } = await setupTestData('USD', 'USD'));
    });

    it('1. Simple contribution without host fees', async () => {
      await collective.update({ hostFeePercent: 0 });
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      await snapshotLedger(SNAPSHOT_COLUMNS);

      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(10000);
        expect(await host.getTotalMoneyManaged()).to.eq(10000);
        expect(await host.getBalance({ useMaterializedView })).to.eq(0);
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(0);
      }
    });

    it('2. Simple contribution with 5% host fees', async () => {
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      await snapshotLedger(SNAPSHOT_COLUMNS);

      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(9500); // 1000 - 5% host fee
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(9500);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(10000);
        expect(await host.getBalance({ useMaterializedView })).to.eq(500); // 5% host fee
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(0);
      }
    });

    it('3. Simple contribution with 5% host fees and indirect platform tip (unsettled)', async () => {
      const order = await fakeOrder({ ...baseOrderData, platformTipAmount: 1000 });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      await snapshotLedger(SNAPSHOT_COLUMNS);

      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(9000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(8550);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(10000); // Tip is still on host's account
        expect(await host.getBalance({ useMaterializedView })).to.eq(1450);
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(1450);
        // TODO We should have a "Projected balance" that removes everything owed
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(0);
      }
    });

    it('4. Simple contribution with 5% host fees and indirect platform tip (settled)', async () => {
      // Create initial order
      const order = await fakeOrder({ ...baseOrderData, platformTipAmount: 1000 });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);

      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(9000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(8550);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(8932); // 10000 - 1000 (platform tip) - 68 (host fee share)
        expect(await host.getBalance({ useMaterializedView })).to.eq(382); // 450 (host fee) - 68 (host fee share)
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(382);
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(1068); // 1000 (platform tip) + 98 (host fee share)
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(1068);
      }
    });

    it('5. Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        platformTipAmount: 1000,
        data: { paymentProcessorFeeInHostCurrency: 200 },
      });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      // New checks for payment processor fees
      for (const useMaterializedView of [false, true]) {
        console.debug('useMaterializedView => ', useMaterializedView);
        expect(await collective.getBalance({ useMaterializedView })).to.eq(8350); // (10000 Total - 1000 platform tip) - 5% host fee (450) - 200 processor fees
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(9000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(8350);
        expect(await host.getTotalMoneyManaged()).to.eq(8732); // 10000 - 1000 (tip) - 200 (processor fee) - 68 (host fee share)
      }

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 450,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 1000,
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: 68,
        pendingHostFeeShare: 0,
        hostFeeSharePercent: 15,
        settledHostFeeShare: 68,
        totalMoneyManaged: 8732,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);

      for (const useMaterializedView of [false, true]) {
        console.log('useMaterializedView => ', useMaterializedView);
        expect(await collective.getBalance({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(0);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(-1268);
        expect(await host.getBalance({ useMaterializedView })).to.eq(-1268); // Will be -200 after settlement (platform tip)
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(-1268);
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(1068);
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(1068);
      }

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -1000,
        hostFeeShare: 0, // Refunded. -> 68 - 68 = 0
        hostFeeSharePercent: 15,
        pendingHostFeeShare: -68, // -> 0 - 68 = -68 (Negative because owed by platform)
        settledHostFeeShare: 68, // hostFeeShare - pendingHostFeeShare (weak metric)
        totalMoneyManaged: -1268,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });

    it('6. Expense marked as unpaid with Payment Processor fees NOT REFUNDED', async () => {
      await collective.update({ hostFeePercent: 0 });
      const order = await fakeOrder({ ...baseOrderData, totalAmount: 150000 });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      const expense = await fakeExpense({
        description: `Invoice #1`,
        amount: 100000,
        currency: host.currency,
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: collective.id,
        legacyPayoutMethod: 'manual',
        status: 'APPROVED',
      });

      await payExpense({ remoteUser: hostAdmin } as any, {
        id: expense.id,
        forceManual: true,
        totalAmountPaidInHostCurrency: 100000 + 500,
        paymentProcessorFeeInHostCurrency: 500,
      });

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(150000 - 100000 - 500); // $1500 (contribution) - $1000 (expense) - $5 (expense processor fee) = $495
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(150000); // $1500 (contribution)
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(150000); // $1500 (contribution)
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(100000); // $1000 (expense)
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(100000 + 500); // $1000 (expense) + $5 (expense processor fee)
      }

      await markExpenseAsUnpaid({ remoteUser: hostAdmin } as any, expense.id, false);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(150000); // $1500 (contribution)
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(150000); // $1500 (contribution)
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(150000); // $1500 (contribution)
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(0); // Expense refunded => no amount spent
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(0); // Expense refunded => no amount spent

        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(150000 - 500);
        expect(await host.getBalance({ useMaterializedView })).to.eq(-500);
      }
    });

    it('7. Expense marked as unpaid with Payment Processor fees REFUNDED', async () => {
      await collective.update({ hostFeePercent: 0 });
      const order = await fakeOrder({ ...baseOrderData, totalAmount: 150000 });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      const expense = await fakeExpense({
        description: `Invoice #1`,
        amount: 100000,
        currency: host.currency,
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: collective.id,
        legacyPayoutMethod: 'manual',
        status: 'APPROVED',
      });

      await payExpense({ remoteUser: hostAdmin } as any, {
        id: expense.id,
        forceManual: true,
        totalAmountPaidInHostCurrency: 100000 + 500,
        paymentProcessorFeeInHostCurrency: 500,
      });

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(150000 - 100000 - 500);
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(100000);
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(100000 + 500);
      }

      await markExpenseAsUnpaid({ remoteUser: hostAdmin } as any, expense.id, true);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(150000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(150000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(150000);
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(0);

        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(150000);
        expect(await host.getBalance({ useMaterializedView })).to.eq(0);
      }
    });
  });

  describe('Level 2: Host with a different currency (Host=EUR, Collective=EUR)', () => {
    beforeEach(async () => {
      ({ collective, host, hostAdmin, ocInc, contributorUser, baseOrderData } = await setupTestData('EUR', 'EUR'));
    });

    it('Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        platformTipAmount: 1000,
        data: { paymentProcessorFeeInHostCurrency: 200 },
      });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      const hostToPlatformFxRate = RATES[host.currency]['USD'];
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await host.getBalance({ useMaterializedView })).to.eq(382);
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(382);
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(Math.round(1068 * hostToPlatformFxRate));
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(
          Math.round(1068 * hostToPlatformFxRate),
        );
        expect(await collective.getBalance({ useMaterializedView })).to.eq(8350); // (10000 Total - 1000 platform tip) - 5% host fee (450) - 200 processor fees
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(9000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(8350);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(8732); // 10000 - 1000 - 200 - 68
      }

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 450,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 1000,
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: 68,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: 68,
        totalMoneyManaged: 8732,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(0); // refunds should not count in amountReceived
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(0);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(-1268);
        expect(await host.getBalance({ useMaterializedView })).to.eq(-1268); // Will be +200 after settlement (platform tip refund) +68 (host fee share refund)
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(-1268);
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(Math.round(1068 * hostToPlatformFxRate));
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(
          Math.round(1068 * hostToPlatformFxRate),
        );
      }

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -1000,
        hostFeeShare: 0, // Refunded
        hostFeeSharePercent: 15,
        pendingHostFeeShare: -68, // -> 0 - 68 = -68 (Negative because owed by platform)
        settledHostFeeShare: 68, // hostFeeShare - pendingHostFeeShare (weak metric)
        totalMoneyManaged: -1268,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });
  });

  describe('Level 3: Host and collective with different currencies (Host=EUR, Collective=JPY) 🤯️', () => {
    beforeEach(async () => {
      ({ collective, host, hostAdmin, ocInc, contributorUser, baseOrderData } = await setupTestData('EUR', 'JPY'));
      await host.update({ settings: { ...host.settings, features: { crossCurrencyManualTransactions: true } } });
    });

    it('Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      const hostToPlatformFxRate = RATES[host.currency]['USD'];
      const collectiveToHostFxRate = RATES[collective.currency][host.currency];
      const hostToCollectiveFxRate = 1 / collectiveToHostFxRate; // This is how `calculateNetAmountInCollectiveCurrency` gets the reverse rate
      const platformTipInCollectiveCurrency = 10000000;
      const platformTipInHostCurrency = platformTipInCollectiveCurrency * collectiveToHostFxRate;
      const processorFeeInHostCurrency = 200;
      const processorFeeInCollectiveCurrency = Math.round(processorFeeInHostCurrency * hostToCollectiveFxRate);
      const orderAmountInCollectiveCurrency = 100000000;
      const orderAmountInHostCurrency = orderAmountInCollectiveCurrency * collectiveToHostFxRate;
      const orderNetAmountInHostCurrency = orderAmountInHostCurrency - platformTipInHostCurrency;
      const expectedHostFeeInHostCurrency = Math.round(orderNetAmountInHostCurrency * 0.05);
      const expectedHostFeeInCollectiveCurrency = Math.round(expectedHostFeeInHostCurrency * hostToCollectiveFxRate);
      const expectedHostFeeShareInHostCurrency = Math.round(expectedHostFeeInHostCurrency * 0.15);
      const expectedHostProfitInHostCurrency = expectedHostFeeInHostCurrency - expectedHostFeeShareInHostCurrency;
      const expectedPlatformProfitInHostCurrency = expectedHostFeeShareInHostCurrency + platformTipInHostCurrency;
      const expectedNetAmountInHostCurrency =
        orderNetAmountInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency;

      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        totalAmount: orderAmountInCollectiveCurrency, // JPY has a lower value, we need to set a higher amount to trigger the settlement
        platformTipAmount: platformTipInCollectiveCurrency,
        data: {
          paymentProcessorFeeInHostCurrency: processorFeeInHostCurrency,
        },
      });
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await host.getBalance({ useMaterializedView })).to.eq(expectedHostProfitInHostCurrency);
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(expectedHostProfitInHostCurrency);
        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(expectedNetAmountInHostCurrency);

        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(
          Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
        );
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(
          Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
        );

        expect(await collective.getBalance({ useMaterializedView, version: 'v1' })).to.eq(
          orderAmountInCollectiveCurrency -
            platformTipInCollectiveCurrency -
            expectedHostFeeInCollectiveCurrency -
            processorFeeInCollectiveCurrency,
        );

        expect(await collective.getBalance({ useMaterializedView })).to.eq(
          Math.round(
            (orderNetAmountInHostCurrency - processorFeeInHostCurrency - expectedHostFeeInHostCurrency) *
              RATES[host.currency][collective.currency],
          ),
        );

        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(
          Math.round(orderNetAmountInHostCurrency * RATES[host.currency][collective.currency]),
        );

        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(
          Math.round(
            (orderNetAmountInHostCurrency - processorFeeInHostCurrency - expectedHostFeeInHostCurrency) *
              RATES[host.currency][collective.currency],
          ),
        );
      }

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: expectedHostFeeInHostCurrency,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: Math.round((platformTipInCollectiveCurrency * RATES.JPY.USD) / RATES.EUR.USD),
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: expectedHostFeeShareInHostCurrency,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: expectedHostFeeShareInHostCurrency,
        totalMoneyManaged: expectedNetAmountInHostCurrency,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(0);

        expect(await host.getTotalMoneyManaged({ useMaterializedView })).to.eq(
          -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
        );
        expect(await host.getBalance({ useMaterializedView })).to.eq(
          -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
        );
        expect(await host.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(
          -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
        );
        expect(await ocInc.getBalance({ useMaterializedView })).to.eq(
          Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
        );
        expect(await ocInc.getBalanceWithBlockedFunds({ useMaterializedView })).to.eq(
          Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
        );
      }

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -platformTipInHostCurrency,
        hostFeeShare: 0, // Refunded
        hostFeeSharePercent: 15,
        pendingHostFeeShare: -expectedHostFeeShareInHostCurrency, // Negative because owed by platform
        settledHostFeeShare: expectedHostFeeShareInHostCurrency, // hostFeeShare - pendingHostFeeShare (weak metric)
        totalMoneyManaged: -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });
  });

  describe('Level 4: Refund added funds️', async () => {
    const refundTransaction = async (collective, host, contributorUser, baseOrderData) => {
      const order = await fakeOrder(baseOrderData);
      set(order, 'data.hostFeePercent', 0);
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.HOST,
        CollectiveId: host.id,
      } as any;
      await executeOrder(contributorUser, order);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
      }

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: TransactionKind.ADDED_FUNDS, type: 'CREDIT' },
      });

      const paymentMethod = findPaymentMethodProvider(order.paymentMethod);
      await paymentMethod.refundTransaction(contributionTransaction);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(0);
      }
    };

    it('Refund added funds with same collective', async () => {
      const { collective, host, contributorUser, baseOrderData } = await setupTestData('USD', 'USD', true);
      await refundTransaction(collective, host, contributorUser, baseOrderData);
    });

    it('Refund added funds with different collectives', async () => {
      const { collective, host, contributorUser, baseOrderData } = await setupTestData('USD', 'USD', false, true);
      await refundTransaction(collective, host, contributorUser, baseOrderData);
    });
  });

  describe('Level 5: Refund Expenses️', async () => {
    const refundTransaction = async (
      collective,
      fromCollective,
      host,
      hostAdmin,
      contributorUser,
      baseOrderData,
      {
        feesPayer = 'COLLECTIVE',
        paymentProcessorFeeInHostCurrency = 0,
        refundedPaymentProcessorFeeInHostCurrency = 0,
      } = {},
    ) => {
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(9500);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(9500);
      }

      const expense = await fakeExpense({
        description: `Invoice #2`,
        amount: 1000,
        currency: host.currency,
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        legacyPayoutMethod: 'manual',
        status: 'APPROVED',
        feesPayer,
      });

      await payExpense({ remoteUser: hostAdmin } as any, {
        id: expense.id,
        forceManual: true,
        paymentProcessorFeeInHostCurrency,
        totalAmountPaidInHostCurrency: 1000,
      });

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        console.log('useMaterializedView => ', useMaterializedView);
        expect(await collective.getBalance({ useMaterializedView })).to.eq(8500);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(
          9500 - paymentProcessorFeeInHostCurrency,
        );
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(1000); // TODO: This is failing with the materialized view
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(1000);
      }

      // ---- Refund transaction -----
      const expenseTransaction = await models.Transaction.findOne({
        where: { ExpenseId: expense.id, kind: TransactionKind.EXPENSE, type: 'DEBIT' },
      });

      const paymentProvider = paymentProviders.opencollective.types.default;
      await paymentProvider.refundTransaction(expenseTransaction, null, refundedPaymentProcessorFeeInHostCurrency);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(9500);
        expect(await collective.getTotalAmountReceived({ useMaterializedView })).to.eq(10000);
        expect(await collective.getTotalAmountReceived({ useMaterializedView, net: true })).to.eq(
          9500 - paymentProcessorFeeInHostCurrency,
        );
        expect(await collective.getTotalAmountSpent({ useMaterializedView })).to.eq(0);
        expect(await collective.getTotalAmountSpent({ useMaterializedView, net: true })).to.eq(0);
      }
    };

    it('Refund expense with same collective', async () => {
      const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
      await refundTransaction(collective, collective, host, hostAdmin, contributorUser, baseOrderData);

      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView })).to.eq(9500);
      }
    });

    it('Refund expense with different collectives', async () => {
      const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
      const secondCollective = await fakeCollective({ name: 'JHipster', HostCollectiveId: host.id });

      await refundTransaction(collective, secondCollective, host, hostAdmin, contributorUser, baseOrderData);

      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await secondCollective.getBalance({ useMaterializedView })).to.eq(0);
      }
    });

    // TODO: Finish this!
    // it('Refund an expense that had feesPayer=PAYEE', async () => {
    //   const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
    //   const secondCollective = await fakeCollective({ name: 'JHipster', HostCollectiveId: host.id });
    //   await refundTransaction(collective, secondCollective, host, hostAdmin, contributorUser, baseOrderData, {
    //     feesPayer: 'PAYEE',
    //     paymentProcessorFeeInHostCurrency: 100,
    //     refundedPaymentProcessorFeeInHostCurrency: 100,
    //   });

    //   await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES); // TODO This snapshot looks wrong
    //   await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
    //   for (const useMaterializedView of [false, true]) {
    //     expect(await collective.getBalance({ useMaterializedView })).to.eq(9500);
    //   }
    // });
  });

  describe('Level 6: Disputed Transactions', async () => {
    const disputeTransaction = async (collective, fromCollective, host, hostAdmin, contributorUser, baseOrderData) => {
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = {
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.MANUAL,
        paid: true,
      } as any;
      await executeOrder(contributorUser, order);

      await models.Transaction.update(
        {
          data: {
            charge: { id: (stripeMocks.webhook_dispute_created.data.object as Stripe.Dispute).charge } as Stripe.Charge,
          },
          HostCollectiveId: host.id,
        },
        { where: { OrderId: order.id } },
      );
      await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
    };

    it('1. Dispute is created', async () => {
      const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
      await disputeTransaction(collective, collective, host, hostAdmin, contributorUser, baseOrderData);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView }), 'Total Balance').to.eq(9500);
        expect(
          await collective.getBalanceWithBlockedFunds({ useMaterializedView }),
          'Balance without Blocked Funds',
        ).to.eq(0);
      }
    });

    it('2. Dispute is created and then closed as lost', async () => {
      const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
      await disputeTransaction(collective, collective, host, hostAdmin, contributorUser, baseOrderData);
      await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView }), 'Total Balance').to.eq(0);
        expect(
          await collective.getBalanceWithBlockedFunds({ useMaterializedView }),
          'Balance without Blocked Funds',
        ).to.eq(0);
      }
    });

    it('3. Dispute is created and then closed as won', async () => {
      const { collective, host, hostAdmin, contributorUser, baseOrderData } = await setupTestData('USD', 'USD');
      await disputeTransaction(collective, collective, host, hostAdmin, contributorUser, baseOrderData);
      await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);
      await snapshotLedger(SNAPSHOT_COLUMNS);

      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
      for (const useMaterializedView of [false, true]) {
        expect(await collective.getBalance({ useMaterializedView }), 'Total Balance').to.eq(9500);
        expect(
          await collective.getBalanceWithBlockedFunds({ useMaterializedView }),
          'Balance without Blocked Funds',
        ).to.eq(9500);
      }
    });
  });
});
