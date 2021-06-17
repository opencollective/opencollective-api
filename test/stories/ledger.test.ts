/**
 * This test is meant to test the common workflows for the ledger: record a contribution,
 * refund it, add platform tips, etc.
 */

import { expect } from 'chai';
import express from 'express';
import moment from 'moment';

import { run as runSettlementScript } from '../../cron/monthly/host-settlement';
import {
  PLATFORM_TIP_TRANSACTION_PROPERTIES,
  SETTLEMENT_EXPENSE_PROPERTIES,
} from '../../server/constants/transactions';
import { payExpense } from '../../server/graphql/common/expenses';
import { createRefundTransaction, executeOrder } from '../../server/lib/payments';
import models from '../../server/models';
import { fakeCollective, fakeHost, fakeOrder, fakePayoutMethod, fakeUser } from '../test-helpers/fake-data';
import { resetTestDB, snapshotLedger } from '../utils';

const SNAPSHOT_COLUMNS = [
  'TransactionGroup',
  'kind',
  'type',
  'amount',
  'paymentProcessorFeeInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'settlementStatus',
  'isRefund',
];

describe('test/stories/ledger', () => {
  let collective, host, hostAdmin, ocInc, contributorUser, baseOrderData;

  beforeEach(async () => {
    // TODO: The setup should ideally insert other hosts and transactions to make sure the balance queries are filtering correctly

    await resetTestDB();
    hostAdmin = await fakeUser();
    host = await fakeHost({ name: 'OSC', admin: hostAdmin.collective });
    await hostAdmin.populateRoles();
    await host.update({ HostCollectiveId: host.id, isActive: true });
    collective = await fakeCollective({ HostCollectiveId: host.id, name: 'ESLint', hostFeePercent: 5 });
    contributorUser = await fakeUser(undefined, { name: 'Ben' });
    ocInc = await fakeHost({ name: 'OC Inc', id: PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId });
    await fakePayoutMethod({ type: 'OTHER', CollectiveId: ocInc.id }); // For the settlement expense
    await fakeUser({ id: SETTLEMENT_EXPENSE_PROPERTIES.UserId, name: 'Pia' });
    baseOrderData = {
      description: `Financial contribution to ${collective.name}`,
      totalAmount: 10000,
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: collective.id,
      PaymentMethodId: null,
    };
  });

  afterEach(async () => {
    const transactions = await models.Transaction.findAll({ order: [['id', 'DESC']] });
    await Promise.all(
      transactions.map(transaction => models.Transaction.validate(transaction, { validateOppositeTransaction: true })),
    );
  });

  describe('Level 1: Same currency', () => {
    it('1. Simple contribution without host fees', async () => {
      await collective.update({ hostFeePercent: 0 });
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(10000);
      expect(await host.getTotalMoneyManaged()).to.eq(10000);
      expect(await host.getBalance()).to.eq(0);
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('2. Simple contribution with 5% host fees', async () => {
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(9500); // 1000 - 5% host fee
      expect(await host.getTotalMoneyManaged()).to.eq(10000);
      expect(await host.getBalance()).to.eq(500); // 5% host fee
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('3. Simple contribution with 5% host fees and indirect platform tip (unsettled)', async () => {
      const order = await fakeOrder({ ...baseOrderData, data: { isFeesOnTop: true, platformFee: 1000 } });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
      expect(await host.getTotalMoneyManaged()).to.eq(10000); // Tip is still on host's account
      expect(await host.getBalance()).to.eq(1450);
      expect(await host.getBalanceWithBlockedFunds()).to.eq(1450);
      // TODO We should have a "Projected balance" that removes everything owed
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('4. Simple contribution with 5% host fees and indirect platform tip (settled)', async () => {
      // Create initial order
      const order = await fakeOrder({ ...baseOrderData, data: { isFeesOnTop: true, platformFee: 1000 } });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await runSettlementScript(moment().add(1, 'month'));
      const settlementExpense = await models.Expense.findOne();
      expect(settlementExpense).to.exist;
      await settlementExpense.update({ status: 'APPROVED' });
      await payExpense(<express.Request>{ remoteUser: hostAdmin }, { id: settlementExpense.id, forceManual: true });

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
      expect(await host.getTotalMoneyManaged()).to.eq(9000); // 10000 - 1000, platform tip is not there anymore
      expect(await host.getBalance()).to.eq(450);
      expect(await host.getBalanceWithBlockedFunds()).to.eq(450);
      expect(await ocInc.getBalance()).to.eq(1000);
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(1000);
    });

    it('5. Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        data: { isFeesOnTop: true, platformFee: 1000, paymentProcessorFeeInHostCurrency: 200 },
      });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await runSettlementScript(moment().add(1, 'month'));
      const settlementExpense = await models.Expense.findOne();
      expect(settlementExpense).to.exist;
      await settlementExpense.update({ status: 'APPROVED' });
      await payExpense(<express.Request>{ remoteUser: hostAdmin }, { id: settlementExpense.id, forceManual: true });

      // New checks for payment processor fees
      expect(await collective.getBalance()).to.eq(8350); // (10000 Total - 1000 platform tip) - 5% host fee (450) - 200 processor fees
      expect(await host.getTotalMoneyManaged()).to.eq(8800); // 10000 - 1000 - 200

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics.hostFees).to.eq(450);
      expect(hostMetrics.platformFees).to.eq(0);
      expect(hostMetrics.pendingPlatformFees).to.eq(0);
      expect(hostMetrics.platformTips).to.eq(1000);
      expect(hostMetrics.pendingPlatformTips).to.eq(0); // Already settled
      expect(hostMetrics.hostFeeShare).to.eq(0);
      expect(hostMetrics.pendingHostFeeShare).to.eq(0);
      expect(hostMetrics.hostFeeSharePercent).to.eq(0);
      expect(hostMetrics.totalMoneyManaged).to.eq(8800);

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(0);
      expect(await host.getTotalMoneyManaged()).to.eq(-1200);
      expect(await host.getBalance()).to.eq(-1200); // Will be -200 after settlement (platform tip)
      expect(await host.getBalanceWithBlockedFunds()).to.eq(-1200);
      expect(await ocInc.getBalance()).to.eq(1000);
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(1000);

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics.hostFees).to.eq(0);
      expect(hostMetrics.platformFees).to.eq(0);
      expect(hostMetrics.pendingPlatformFees).to.eq(0);
      expect(hostMetrics.platformTips).to.eq(0); // There was a 1000 tip, but it was refunded
      expect(hostMetrics.pendingPlatformTips).to.eq(-1000);
      expect(hostMetrics.hostFeeShare).to.eq(0);
      expect(hostMetrics.pendingHostFeeShare).to.eq(0);
      expect(hostMetrics.hostFeeSharePercent).to.eq(0);
      expect(hostMetrics.totalMoneyManaged).to.eq(-1200);

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });
  });

  describe('Level 2: Host with different currency', () => {
    // TODO: Add multi-currencies
  });

  describe('Level 3: Host and collective with different currency', () => {
    // TODO: Add multi-currencies
  });
});
