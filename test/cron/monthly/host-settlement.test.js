import { expect } from 'chai';
import moment from 'moment';
import sinon, { useFakeTimers } from 'sinon';

import { run as invoicePlatformFees } from '../../../cron/monthly/host-settlement';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { createRefundTransaction } from '../../../server/lib/payments';
import { getHostPlatformTipsAccount, getTaxesSummary } from '../../../server/lib/transactions';
import models, { sequelize } from '../../../server/models';
import { ExpenseType } from '../../../server/models/Expense';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakePlatformSubscription,
  fakeTransaction,
  fakeUser,
  fakeUUID,
  randStr,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/monthly/host-settlement', () => {
  const lastMonth = moment.utc().subtract(1, 'month').startOf('month');
  const twoMonthsAgo = moment.utc().subtract(2, 'months').startOf('month');

  let gbpHost,
    eurHost,
    newHost,
    migratedHost,
    smallMigratedHost,
    smallMigratedHostDebtTransactions,
    anomalyHost,
    anomalyHostDebtTransactions,
    eurCollective,
    gphHostSettlementExpense,
    eurHostSettlementExpense,
    newHostSettlementExpense,
    migratedHostSettlementExpense,
    ocStripePayoutMethod;

  before(async () => {
    await utils.resetTestDB();
    const user = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: user.id,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
    ocStripePayoutMethod = (await oc.getPayoutMethods()).find(pm => pm.type === PayoutMethodTypes.STRIPE);

    // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
    await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 1453`);
    await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 31`);
    const payoutProto = {
      data: {
        details: {},
        type: 'IBAN',
        accountHolderName: 'OpenCollective Inc.',
        currency: 'USD',
      },
      CollectiveId: oc.id,
      type: 'BANK_ACCOUNT',
    };
    const defaultBankAccountPayoutMethod = await fakePayoutMethod({
      ...payoutProto,
      id: 2955,
    });

    await fakePayoutMethod({
      ...payoutProto,
      id: 2956,
      data: { ...payoutProto.data, currency: 'GBP' },
    });

    // ---- GBP Host ----
    gbpHost = await fakeHost({
      name: 'GBP host',
      currency: 'GBP',
      plan: 'grow-plan-2021',
      data: { plan: { pricePerCollective: 100 } },
    });
    await fakeConnectedAccount({ CollectiveId: gbpHost.id, service: 'transferwise' });
    const gbpHostBankPaymentMethod = await fakePaymentMethod({
      type: PAYMENT_METHOD_TYPE.BANK_TRANSFER,
      service: PAYMENT_METHOD_SERVICE.WISE,
      CollectiveId: gbpHost.id,
    });
    await fakeExpense({
      CollectiveId: gbpHost.id,
      FromCollectiveId: oc.id,
      type: ExpenseType.SETTLEMENT,
      status: 'PAID',
      PayoutMethodId: defaultBankAccountPayoutMethod.id,
      PaymentMethodId: gbpHostBankPaymentMethod.id,
    });

    const socialCollective = await fakeCollective({ HostCollectiveId: gbpHost.id });
    const transactionProps = {
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: socialCollective.id,
      currency: 'GBP',
      hostCurrency: 'GBP',
      HostCollectiveId: gbpHost.id,
      createdAt: lastMonth,
      data: {
        hostFeeSharePercent: 15,
      },
    };
    // Create Contributions
    const contribution1 = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -600,
      TransactionGroup: fakeUUID('00000001'),
    });
    const contribution2 = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -400,
      TransactionGroup: fakeUUID('00000002'),
    });
    const contribution3 = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -600,
      TransactionGroup: fakeUUID('00000003'),
    });

    // Refunds
    const unsettledRefundedContribution = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -600,
      TransactionGroup: fakeUUID('00000004'),
    });
    const settledRefundedContribution = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 4200,
      hostFeeInHostCurrency: -420,
      createdAt: moment(lastMonth).subtract(1, 'month'),
      TransactionGroup: fakeUUID('00000005'),
    });

    // Create host fee share
    const hostFeeResults = await Promise.all(
      [contribution1, contribution2, contribution3, unsettledRefundedContribution, settledRefundedContribution].map(
        transaction => models.Transaction.createHostFeeTransactions(transaction),
      ),
    );

    await Promise.all(
      hostFeeResults.map(({ transaction, hostFeeTransaction }) =>
        models.Transaction.createHostFeeShareTransactions({
          transaction: transaction,
          hostFeeTransaction: hostFeeTransaction,
        }),
      ),
    );

    // Add Platform Tips
    const contributionWithTipToSettle = await fakeTransaction({
      ...transactionProps,
      TransactionGroup: fakeUUID('00000006'),
    });
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      HostCollectiveId: oc.id,
      amount: 1000,
      currency: 'USD',
      data: { hostToPlatformFxRate: 1.23 },
      TransactionGroup: contributionWithTipToSettle.TransactionGroup,
      kind: TransactionKind.PLATFORM_TIP,
      createdAt: lastMonth,
    });
    const firstTipDebtCredit = await fakeTransaction({
      type: 'CREDIT',
      FromCollectiveId: oc.id,
      CollectiveId: gbpHost.id,
      HostCollectiveId: gbpHost.id,
      amount: 813,
      amountInHostCurrency: 813,
      currency: 'GBP',
      hostCurrency: 'GBP',
      data: { hostToPlatformFxRate: 1.23 },
      TransactionGroup: contributionWithTipToSettle.TransactionGroup,
      kind: TransactionKind.PLATFORM_TIP_DEBT,
      createdAt: lastMonth,
      isDebt: true,
    });
    await models.TransactionSettlement.createForTransaction(firstTipDebtCredit);

    // Collected Platform Tip with pending Payment Processor Fee. No debt here, it's collected directly via Stripe
    const contributionWithTipDirectlySettled = await fakeTransaction({
      ...transactionProps,
      TransactionGroup: fakeUUID('00000007'),
    });
    const paymentMethod = await fakePaymentMethod({ service: 'stripe', token: 'tok_bypassPending' });
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      HostCollectiveId: oc.id,
      amount: 813,
      amountInHostCurrency: 813,
      hostCurrency: 'GBP',
      data: { hostToPlatformFxRate: 1.23 },
      TransactionGroup: contributionWithTipDirectlySettled.TransactionGroup,
      kind: TransactionKind.PLATFORM_TIP,
      paymentProcessorFeeInHostCurrency: -100,
      PaymentMethodId: paymentMethod.id,
      createdAt: lastMonth,
    });

    // Mark settledRefundedContribution as already settled, which suppose we'll have to INVOICE the opposite settlement
    await models.TransactionSettlement.update(
      { status: 'SETTLED' },
      { where: { TransactionGroup: settledRefundedContribution.TransactionGroup } },
    );

    // Refund contributions that must be
    let clock = sinon.useFakeTimers({ toFake: ['Date'], now: moment(lastMonth).add(1, 'day').toDate() });
    await createRefundTransaction(unsettledRefundedContribution, 0, null, user, fakeUUID('00000008'));
    await createRefundTransaction(settledRefundedContribution, 0, null, user, fakeUUID('00000009'));
    clock.restore();

    // ---- EUR Host ----
    // We using a different strategy here: by relying on pending orders + `markAsPaid` we make sure that the rest of the code
    // properly creates the transactions and the host fee share transactions with the right amounts.
    const eurHostAdmin = await fakeUser();
    eurHost = await fakeHost({
      name: 'europe',
      currency: 'EUR',
      plan: 'grow-plan-2021',
      hostFeePercent: 10,
      country: 'BE',
      data: { plan: { hostFeeSharePercent: 50 } },
      settings: { VAT: { type: 'OWN' } },
      admin: eurHostAdmin,
    });
    await fakeConnectedAccount({ CollectiveId: eurHost.id, service: 'transferwise' });

    eurCollective = await fakeCollective({
      HostCollectiveId: eurHost.id,
      currency: 'EUR',
      settings: { VAT: { type: 'HOST' } },
    });

    // Create Contributions
    clock = sinon.useFakeTimers({ now: twoMonthsAgo.toDate(), toFake: ['Date'] }); // Manually setting today's date
    const oldOrder = await fakeOrder({
      description: 'Old EUR Contribution with tip + host fee',
      CollectiveId: eurCollective.id,
      currency: 'EUR',
      status: 'PENDING',
      data: { tax: { id: 'VAT', percentage: 21 } },
      // 1000€ contribution + 300€ platform tip + 210€ VAT (21% of 1000€) = 1510€
      // Will also include 100€ host fee (10% of 1000€), of which 50% will be shared with OC (hostFeeSharePercent: 50)
      platformTipAmount: 300e2,
      taxAmount: 210e2,
      totalAmount: 1510e2,
    });
    await oldOrder.markAsPaid(eurHostAdmin);
    clock.restore();

    clock = sinon.useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] }); // Manually setting today's date
    const order = await fakeOrder({
      description: 'EUR Contribution with tip + host fee',
      CollectiveId: eurCollective.id,
      currency: 'EUR',
      status: 'PENDING',
      data: { tax: { id: 'VAT', percentage: 21 } },
      // 1000€ contribution + 300€ platform tip + 210€ VAT (21% of 1000€) = 1510€
      // Will also include 100€ host fee (10% of 1000€), of which 50% will be shared with OC (hostFeeSharePercent: 50)
      platformTipAmount: 300e2,
      taxAmount: 210e2,
      totalAmount: 1510e2,
    });
    await order.markAsPaid(eurHostAdmin);
    clock.restore();

    const newHostAdmin = await fakeUser();
    newHost = await fakeHost({
      name: 'new-host',
      admin: newHostAdmin,
    });
    clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] }); // Manually setting today's date
    const newOrder = await fakeOrder({
      description: 'Contribution with tip + host fee',
      CollectiveId: newHost.id,
      currency: 'USD',
      status: 'PENDING',
      platformTipAmount: 300e2,
      taxAmount: 210e2,
      totalAmount: 1510e2,
    });
    await newOrder.markAsPaid(newHostAdmin);
    clock.restore();

    // ---- Migrated Host (switched to new platform subscription billing this month) ----
    const migratedHostAdmin = await fakeUser();
    migratedHost = await fakeHost({
      name: 'migrated-host',
      currency: 'USD',
      plan: 'grow-plan-2021',
      hostFeePercent: 10,
      data: { plan: { hostFeeSharePercent: 50 } },
      // Migration date falls within the billing period being settled.
      settings: { automaticBillingMigration: lastMonth.toDate() },
      admin: migratedHostAdmin,
    });
    await fakeConnectedAccount({ CollectiveId: migratedHost.id, service: 'transferwise' });
    await fakePlatformSubscription({ CollectiveId: migratedHost.id, plan: { pricing: { platformTips: true } } });

    const migratedCollective = await fakeCollective({ HostCollectiveId: migratedHost.id, currency: 'USD' });
    clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
    const migratedOrder = await fakeOrder({
      description: 'Contribution on migrated host',
      CollectiveId: migratedCollective.id,
      currency: 'USD',
      status: 'PENDING',
      platformTipAmount: 300e2,
      totalAmount: 1300e2,
    });
    await migratedOrder.markAsPaid(migratedHostAdmin);
    clock.restore();

    // ---- Migrated Host below the MIN_AMOUNT_USD settlement threshold ----
    // Host fee share is too small to warrant an expense, but we still want to
    // mark its HOST_FEE_SHARE_DEBT settlements as SETTLED so they are not
    // carried over into the new platform subscription billing.
    smallMigratedHost = await fakeHost({
      name: 'small-migrated-host',
      currency: 'USD',
      settings: { automaticBillingMigration: lastMonth.toDate() },
    });
    await fakePlatformSubscription({ CollectiveId: smallMigratedHost.id });
    const smallMigratedCollective = await fakeCollective({
      HostCollectiveId: smallMigratedHost.id,
      currency: 'USD',
    });
    const smallContribution = await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: smallMigratedCollective.id,
      HostCollectiveId: smallMigratedHost.id,
      currency: 'USD',
      hostCurrency: 'USD',
      amount: 100,
      hostFeeInHostCurrency: -10,
      createdAt: lastMonth,
      data: { hostFeeSharePercent: 15 },
      TransactionGroup: fakeUUID('00000020'),
    });
    const { transaction: smallWithHostFee, hostFeeTransaction: smallHostFee } =
      await models.Transaction.createHostFeeTransactions(smallContribution);
    await models.Transaction.createHostFeeShareTransactions({
      transaction: smallWithHostFee,
      hostFeeTransaction: smallHostFee,
    });
    smallMigratedHostDebtTransactions = await models.Transaction.findAll({
      where: { HostCollectiveId: smallMigratedHost.id, isDebt: true, kind: TransactionKind.HOST_FEE_SHARE_DEBT },
    });

    // ---- Anomaly host: HOST_FEE_SHARE_DEBT transactions created while the
    //      new platform subscription billing was already in place.
    anomalyHost = await fakeHost({
      name: 'anomaly-host',
      currency: 'USD',
    });
    // Subscription started two months ago, so it covers `lastMonth` entirely.
    await fakePlatformSubscription({
      CollectiveId: anomalyHost.id,
      period: [{ value: twoMonthsAgo.toDate(), inclusive: true }, null],
    });
    const anomalyCollective = await fakeCollective({ HostCollectiveId: anomalyHost.id, currency: 'USD' });
    const anomalyContribution = await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: anomalyCollective.id,
      HostCollectiveId: anomalyHost.id,
      currency: 'USD',
      hostCurrency: 'USD',
      amount: 100000,
      hostFeeInHostCurrency: -10000,
      // Transactions happen during the new billing period — they should not be
      // charged via Platform Share.
      createdAt: lastMonth.clone().add(1, 'day').toDate(),
      data: { hostFeeSharePercent: 20 },
      TransactionGroup: fakeUUID('00000030'),
    });
    const { transaction: anomalyWithHostFee, hostFeeTransaction: anomalyHostFee } =
      await models.Transaction.createHostFeeTransactions(anomalyContribution);
    await models.Transaction.createHostFeeShareTransactions({
      transaction: anomalyWithHostFee,
      hostFeeTransaction: anomalyHostFee,
    });
    anomalyHostDebtTransactions = await models.Transaction.findAll({
      where: { HostCollectiveId: anomalyHost.id, isDebt: true, kind: TransactionKind.HOST_FEE_SHARE_DEBT },
    });

    // ---- Trigger settlement ----
    await invoicePlatformFees();

    gphHostSettlementExpense = (await gbpHost.getExpenses())[0];
    expect(gphHostSettlementExpense).to.exist;
    gphHostSettlementExpense.items = await gphHostSettlementExpense.getItems();
    eurHostSettlementExpense = (await eurHost.getExpenses())[0];
    expect(eurHostSettlementExpense).to.exist;
    eurHostSettlementExpense.items = await eurHostSettlementExpense.getItems();

    newHostSettlementExpense = (await newHost.getExpenses())[0];
    expect(newHostSettlementExpense).to.exist;
    newHostSettlementExpense.items = await newHostSettlementExpense.getItems();

    migratedHostSettlementExpense = (await migratedHost.getExpenses())[0];
    expect(migratedHostSettlementExpense).to.exist;
    migratedHostSettlementExpense.items = await migratedHostSettlementExpense.getItems();
  });

  // Resync DB to make sure we're not touching other tests
  after(async () => {
    await utils.resetTestDB();
  });

  it('should use stripe payout method by default for new host', () => {
    expect(newHostSettlementExpense).to.have.property('PayoutMethodId', ocStripePayoutMethod.id);
  });

  it('should invoice the host in its own currency', () => {
    expect(gphHostSettlementExpense).to.have.property('currency', 'GBP');
    expect(gphHostSettlementExpense).to.have.property('description').that.includes('Platform settlement for');
    expect(gphHostSettlementExpense).to.have.nested.property('data.isPlatformTipSettlement', true);
  });

  it('should invoice platform tips not collected through Stripe', async () => {
    const platformTipsItem = gphHostSettlementExpense.items.find(p => p.description === 'Platform Tips');
    expect(platformTipsItem).to.have.property('amount', Math.round(1000 / 1.23));
  });

  it('should use our preferred payout bank info despite host currency', () => {
    expect(gphHostSettlementExpense).to.have.property('PayoutMethodId', 2955);
  });

  it('should invoice pending shared host revenue', async () => {
    const sharedRevenueItem = gphHostSettlementExpense.items.find(p => p.description === 'Platform Share');
    const expectedRevenue = Math.round(1600 * 0.15);
    const expectedRefund = Math.round(420 * 0.15);
    expect(sharedRevenueItem).to.have.property('amount', expectedRevenue - expectedRefund);
  });

  it('should attach detailed list of transactions in the expense', async () => {
    const [attachment] = await gphHostSettlementExpense.getAttachedFiles();
    expect(attachment).to.have.property('url');
    expect(attachment.url).to.have.string('.csv');
    // Legacy hosts keep the account-scoped report (all their settled rows live on the host account)
    expect(attachment.url).to.have.string('/transactions.csv');
    // hasDebt is only meaningful for new-ledger PLATFORM_TIP rows; legacy *_DEBT kinds are debts by
    // definition and would return nothing with hasDebt=true
    expect(new URL(attachment.url).searchParams.get('hasDebt')).to.be.null;
  });

  it('should include entries from previous months in the CSV url startDate', async () => {
    const [attachment] = await eurHostSettlementExpense.getAttachedFiles();
    expect(attachment).to.have.property('url');
    const csvUrl = new URL(attachment.url);
    const dateFrom = csvUrl.searchParams.get('dateFrom');
    expect(dateFrom).to.exist;
    expect(dateFrom).to.eq(twoMonthsAgo.toISOString());
  });

  it('should consider fixed fee per host collective', async () => {
    const reimburseItem = gphHostSettlementExpense.items.find(p => p.description === 'Fixed Fee per Hosted Collective');
    expect(reimburseItem).to.have.property('amount', 100);
  });

  it('should update all settlement status for EU host', async () => {
    const eurHostTransactions = await models.Transaction.findAll({
      where: { HostCollectiveId: eurHost.id },
      attributes: ['TransactionGroup'],
      group: ['TransactionGroup'],
      raw: true,
    });

    const countSettlements = status =>
      models.TransactionSettlement.count({
        where: { status, TransactionGroup: eurHostTransactions.map(t => t.TransactionGroup) },
      });

    await utils.snapshotLedger(['kind', 'type', 'amount', 'isRefund', 'settlementStatus'], {
      where: { isDebt: true, HostCollectiveId: eurHost.id },
      order: [['id', 'ASC']],
    });

    expect(await countSettlements('INVOICED')).to.eq(4); // 2 contributions, each one with platform tip + host fee share
    expect(await countSettlements('SETTLED')).to.eq(0);
  });

  it('should update all settlement status for GBP host', async () => {
    const gbpHostTransactions = await models.Transaction.findAll({
      where: { HostCollectiveId: gbpHost.id },
      attributes: ['TransactionGroup'],
      group: ['TransactionGroup'],
      raw: true,
    });

    const countSettlements = status =>
      models.TransactionSettlement.count({
        where: { status, TransactionGroup: gbpHostTransactions.map(t => t.TransactionGroup) },
      });

    await utils.snapshotLedger(['TransactionGroup', 'kind', 'type', 'amount', 'isRefund', 'settlementStatus'], {
      where: { isDebt: true, HostCollectiveId: gbpHost.id },
      order: [
        ['TransactionGroup', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    expect(await countSettlements('INVOICED')).to.eq(5); // 1 Platform tip + 3 host fee share + 1 host fee share refund
    expect(await countSettlements('SETTLED')).to.eq(3); // (Host fee share + Host fee share refund) for unsettledRefundedContribution + host fee share for settledRefundedContribution
  });

  it('settlement should play nicely with taxes', async () => {
    expect(eurHostSettlementExpense.currency).to.eq('EUR');
    expect(eurHostSettlementExpense.items).to.have.length(2);
    expect(eurHostSettlementExpense.items[0].description).to.eq('Platform Tips');
    expect(eurHostSettlementExpense.items[0].amount).to.eq(600e2); // 2 contributions
    expect(eurHostSettlementExpense.items[1].description).to.eq('Platform Share');
    expect(eurHostSettlementExpense.items[1].amount).to.eq(100e2); // 50€ (100€ host fee * 50% host fee share)
    expect(eurHostSettlementExpense.amount).to.eq(700e2); // Tips + shared revenue
  });

  it('collective balance reflects the taxes & host fees properly', async () => {
    const balanceAmount = await eurCollective.getBalanceAmount();
    expect(balanceAmount.currency).to.eq('EUR');
    expect(balanceAmount.value).to.eq(1800e2); // 2 contributions x 1000€ - 200€ (host fee)
  });

  it('has recorded the right amount of taxes', async () => {
    const eurHostTransactionGroups = await models.Transaction.findAll({
      where: { HostCollectiveId: eurHost.id },
      attributes: ['TransactionGroup'],
      group: ['TransactionGroup'],
      raw: true,
    });

    const eurHostTransactions = await models.Transaction.findAll({
      where: { TransactionGroup: eurHostTransactionGroups.map(t => t.TransactionGroup) },
    });

    const summary = getTaxesSummary(eurHostTransactions);
    expect(summary.VAT.collected).to.eq(420e2); // 2 contributions x 21% of 1000€
  });

  describe('last Platform Share settlement comment for migrated hosts', () => {
    it('adds a comment on the Platform Share expense of a host migrated this month', async () => {
      const comments = await models.Comment.findAll({
        where: { ExpenseId: migratedHostSettlementExpense.id },
      });
      expect(comments).to.have.length(1);
      const [comment] = comments;
      expect(comment.FromCollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
      expect(comment.CreatedByUserId).to.equal(PlatformConstants.PlatformUserId);
      expect(comment.CollectiveId).to.equal(migratedHost.id);
      expect(comment.html).to.include('last Platform Share settlement');
      expect(comment.html).to.include('Platform Tips settlements will continue to be billed as usual.');
    });

    it('links to the new platform subscription dashboard in the comment', async () => {
      const comment = await models.Comment.findOne({
        where: { ExpenseId: migratedHostSettlementExpense.id },
      });
      expect(comment.html).to.include(`/dashboard/${migratedHost.slug}/platform-subscription`);
    });

    it('does not add the comment on expenses for hosts that were not migrated this month', async () => {
      for (const expense of [gphHostSettlementExpense, eurHostSettlementExpense, newHostSettlementExpense]) {
        const count = await models.Comment.count({ where: { ExpenseId: expense.id } });
        expect(count, `Expense #${expense.id} should not have a comment`).to.equal(0);
      }
    });
  });

  describe('settle carried-over HOST_FEE_SHARE_DEBT for migrated hosts below the amount threshold', () => {
    it('does not create a settlement expense when the total is below the threshold', async () => {
      const expenses = await smallMigratedHost.getExpenses();
      expect(expenses).to.have.length(0);
    });

    it('marks HOST_FEE_SHARE_DEBT settlements as SETTLED for migrated hosts below the threshold', async () => {
      expect(smallMigratedHostDebtTransactions).to.have.length.greaterThan(0);
      const settlements = await models.TransactionSettlement.findAll({
        where: {
          TransactionGroup: smallMigratedHostDebtTransactions.map(t => t.TransactionGroup),
          kind: TransactionKind.HOST_FEE_SHARE_DEBT,
        },
      });
      expect(settlements).to.have.length(smallMigratedHostDebtTransactions.length);
      for (const settlement of settlements) {
        expect(settlement.status).to.equal('SETTLED');
      }
    });
  });

  describe('never charges Platform Share for transactions during the new billing period', () => {
    it('does not create a settlement expense when HOST_FEE_SHARE_DEBT overlaps with the platform subscription', async () => {
      const expenses = await anomalyHost.getExpenses();
      expect(expenses).to.have.length(0);
    });

    it('leaves HOST_FEE_SHARE_DEBT settlements as OWED so they can be investigated manually', async () => {
      expect(anomalyHostDebtTransactions).to.have.length.greaterThan(0);
      const settlements = await models.TransactionSettlement.findAll({
        where: {
          TransactionGroup: anomalyHostDebtTransactions.map(t => t.TransactionGroup),
          kind: TransactionKind.HOST_FEE_SHARE_DEBT,
        },
      });
      expect(settlements).to.have.length(anomalyHostDebtTransactions.length);
      for (const settlement of settlements) {
        expect(settlement.status).to.equal('OWED');
      }
    });

    it('logs a loud warning pointing at the offending transactions', async () => {
      // Re-run with a stubbed console.warn so we can assert on the log output.
      const warnStub = sinon.stub(console, 'warn');
      try {
        await invoicePlatformFees();
      } finally {
        warnStub.restore();
      }
      const warnings = warnStub.getCalls().map(call => call.args.join(' '));
      const anomalyWarning = warnings.find(
        msg => msg.includes(anomalyHost.name) && msg.includes('HOST_FEE_SHARE_DEBT'),
      );
      expect(anomalyWarning, `expected a warning mentioning ${anomalyHost.name}`).to.exist;
      expect(anomalyWarning).to.include('platform subscription');
      for (const t of anomalyHostDebtTransactions) {
        expect(anomalyWarning).to.include(`#${t.id}`);
      }
    });
  });

  describe('NEW_PLATFORM_TIPS_LEDGER host', () => {
    let newLedgerHost, platformTipsAccount, platformTipCredit, settlementExpense;

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      // The cron requires a USD BANK_ACCOUNT payout method on the platform org.
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 2000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 50`);

      const hostAdmin = await fakeUser();
      newLedgerHost = await fakeHost({
        name: 'new-ledger-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: newLedgerHost.id, service: 'transferwise' });

      const collective = await fakeCollective({ HostCollectiveId: newLedgerHost.id, currency: 'USD' });

      // Drive a contribution with a tip through markAsPaid so the full createPlatformTipTransactions
      // path runs (writes PLATFORM_TIP on the platform-tips account + TransactionSettlement OWED).
      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      const order = await fakeOrder({
        description: 'Contribution with $50 tip on new-ledger host',
        CollectiveId: collective.id,
        currency: 'USD',
        status: 'PENDING',
        platformTipAmount: 5000,
        totalAmount: 15000,
      });
      await order.markAsPaid(hostAdmin);
      clock.restore();

      // The per-host platform-tips account is created lazily when the first tip is recorded.
      platformTipsAccount = await models.Collective.findOne({ where: { data: { isPlatformTipsAccount: true } } });
      expect(platformTipsAccount, 'tip recording should create the per-host platform-tips account').to.exist;

      platformTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: newLedgerHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
        },
      });
      expect(platformTipCredit, 'PLATFORM_TIP credit should be written on the platform-tips account').to.exist;
      expect(platformTipCredit.amountInHostCurrency).to.equal(5000);

      const initialTs = await models.TransactionSettlement.getByTransaction(platformTipCredit);
      expect(initialTs).to.have.property('status', 'OWED');

      await invoicePlatformFees();

      // The tip is now billed directly against the platform-tips account (host-scoped), not the host.
      const settlementExpenses = await models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: newLedgerHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });
      expect(settlementExpenses, 'cron should bill one SETTLEMENT expense against platform-tips').to.have.length(1);
      settlementExpense = settlementExpenses[0];
      settlementExpense.items = await settlementExpense.getItems();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('bills the platform tip exactly once (regression: prior code double-counted)', () => {
      const platformTipsItem = settlementExpense.items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.amount).to.equal(5000);
    });

    it('bills the tip against the platform-tips account (host-scoped) and writes no release transfer', async () => {
      expect(settlementExpense.CollectiveId).to.equal(platformTipsAccount.id);
      expect(settlementExpense.HostCollectiveId).to.equal(newLedgerHost.id);
      expect(settlementExpense.FromCollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
      expect(settlementExpense.amount).to.equal(5000);

      // No release transfer is written anymore — the held tip stays on the platform-tips slice until
      // the settlement expense is paid, at which point the paid DEBIT (host-scoped) clears it.
      const slice = await models.Transaction.findAll({
        where: { CollectiveId: platformTipsAccount.id, HostCollectiveId: newLedgerHost.id },
      });
      expect(slice.map(t => t.kind)).to.deep.equal([TransactionKind.PLATFORM_TIP]);
    });

    it('flips the PLATFORM_TIP TransactionSettlement from OWED to INVOICED', async () => {
      const ts = await models.TransactionSettlement.getByTransaction(platformTipCredit);
      expect(ts.status).to.equal('INVOICED');
      expect(ts.ExpenseId).to.equal(settlementExpense.id);
    });

    it('attaches a host-scoped CSV so the vendor-account PLATFORM_TIP rows are included', async () => {
      const [attachment] = await settlementExpense.getAttachedFiles();
      expect(attachment).to.have.property('url');
      // The account-scoped `transactions` report filters CollectiveId IN [host, children] and can
      // never return the platform-tips account rows; the host-scoped report filters HostCollectiveId.
      expect(attachment.url).to.have.string('/hostTransactions.csv');
      const csvUrl = new URL(attachment.url);
      expect(csvUrl.searchParams.get('kind').split(',')).to.include('PLATFORM_TIP');
      expect(csvUrl.searchParams.get('add')).to.equal('orderLegacyId');
      // Without it, the kind filter alone would also pull in Stripe direct-collected tips,
      // which are offset by an APPLICATION_FEE and never billed
      expect(csvUrl.searchParams.get('hasDebt')).to.equal('1');
    });

    it('matches the new-ledger settlement ledger snapshot', async () => {
      // Captures the host's platform-tip ledger after settlement, including the currency columns: the
      // held PLATFORM_TIP credit stays on the host's platform-tips slice (no release transfer), in the
      // host currency, so a regression that leaked a foreign hostCurrency would change this snapshot.
      await utils.snapshotLedger(
        ['kind', 'type', 'isDebt', 'amount', 'currency', 'hostCurrency', 'amountInHostCurrency', 'settlementStatus'],
        {
          where: {
            HostCollectiveId: newLedgerHost.id,
            kind: [TransactionKind.PLATFORM_TIP],
          },
          order: [['id', 'ASC']],
        },
      );
    });
  });

  describe('NEW_PLATFORM_TIPS_LEDGER host with a tip refunded after it was invoiced', () => {
    // Full lifecycle: tip B was collected and invoiced last month, then the contribution was
    // refunded. The refund pair carries a fresh OWED settlement (see createRefundTransaction), and
    // this month's run must deduct it from the Platform Tips invoice so the host is billed only the
    // net (held tip A minus refunded tip B).
    let deductionHost, negativeNetHost, platformTipsAccount, heldTipCredit, refundTipDebit, negativeNetRefundDebit;

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 2000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 50`);

      const hostAdmin = await fakeUser();
      deductionHost = await fakeHost({
        name: 'deduction-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: deductionHost.id, service: 'transferwise' });
      // hostFeePercent 0 keeps the settlement to tips only (no Platform Share item)
      const collective = await fakeCollective({
        HostCollectiveId: deductionHost.id,
        currency: 'USD',
        hostFeePercent: 0,
      });

      negativeNetHost = await fakeHost({
        name: 'negative-net-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: negativeNetHost.id, service: 'transferwise' });
      const negativeNetCollective = await fakeCollective({
        HostCollectiveId: negativeNetHost.id,
        currency: 'USD',
        hostFeePercent: 0,
      });

      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      try {
        // Tip A ($50): collected last month, still held — will be invoiced this run.
        const orderA = await fakeOrder({
          description: 'Contribution with $50 tip, still held',
          CollectiveId: collective.id,
          currency: 'USD',
          status: 'PENDING',
          platformTipAmount: 5000,
          totalAmount: 15000,
        });
        await orderA.markAsPaid(hostAdmin);

        // Tip B ($20): collected, then invoiced + released by last month's run, then refunded.
        const orderB = await fakeOrder({
          description: 'Contribution with $20 tip, invoiced then refunded',
          CollectiveId: collective.id,
          currency: 'USD',
          status: 'PENDING',
          platformTipAmount: 2000,
          totalAmount: 12000,
        });
        await orderB.markAsPaid(hostAdmin);

        const tipBCredit = await models.Transaction.findOne({
          where: { OrderId: orderB.id, kind: TransactionKind.PLATFORM_TIP, type: 'CREDIT' },
        });
        const tipBSettlement = await models.TransactionSettlement.getByTransaction(tipBCredit);
        await tipBSettlement.update({ status: 'INVOICED' });

        const contributionBCredit = await models.Transaction.findOne({
          where: { OrderId: orderB.id, kind: TransactionKind.CONTRIBUTION, type: 'CREDIT' },
        });
        await createRefundTransaction(contributionBCredit, 0, null, hostAdmin);

        // Negative-net host: its only activity is a refunded already-invoiced tip ($20), so this
        // run nets negative and everything must roll forward.
        const orderC = await fakeOrder({
          description: 'Contribution with $20 tip, invoiced then refunded (negative-net host)',
          CollectiveId: negativeNetCollective.id,
          currency: 'USD',
          status: 'PENDING',
          platformTipAmount: 2000,
          totalAmount: 12000,
        });
        await orderC.markAsPaid(hostAdmin);
        const tipCCredit = await models.Transaction.findOne({
          where: { OrderId: orderC.id, kind: TransactionKind.PLATFORM_TIP, type: 'CREDIT' },
        });
        await (await models.TransactionSettlement.getByTransaction(tipCCredit)).update({ status: 'INVOICED' });
        const contributionCCredit = await models.Transaction.findOne({
          where: { OrderId: orderC.id, kind: TransactionKind.CONTRIBUTION, type: 'CREDIT' },
        });
        await createRefundTransaction(contributionCCredit, 0, null, hostAdmin);
      } finally {
        clock.restore();
      }

      // This block exercises two hosts, each with its own per-host platform-tips account.
      platformTipsAccount = await getHostPlatformTipsAccount(deductionHost);
      const negativeNetPlatformTipsAccount = await getHostPlatformTipsAccount(negativeNetHost);

      heldTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: deductionHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
          isRefund: false,
          RefundTransactionId: null,
        },
      });
      refundTipDebit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: deductionHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'DEBIT',
          isRefund: true,
        },
      });
      expect(refundTipDebit, 'refund should write a PLATFORM_TIP DEBIT on the vendor').to.exist;
      expect((await models.TransactionSettlement.getByTransaction(refundTipDebit)).status).to.equal('OWED');
      negativeNetRefundDebit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: negativeNetHost.id,
          CollectiveId: negativeNetPlatformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'DEBIT',
          isRefund: true,
        },
      });

      await invoicePlatformFees();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('deducts the refunded invoiced tip from the Platform Tips item (billed against platform-tips)', async () => {
      const expenses = await models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: deductionHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });
      expect(expenses, 'cron should bill one SETTLEMENT expense against platform-tips').to.have.length(1);
      expect(expenses[0].amount).to.equal(3000); // $50 held - $20 refunded
      const items = await expenses[0].getItems();
      const platformTipsItem = items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.amount).to.equal(3000);
    });

    it('writes no release transfer (the held tips stay on the slice until the expense is paid)', async () => {
      // The held credit and the refund deduction remain on the platform-tips slice; they are cleared
      // by the host-scoped DEBIT posted when the settlement expense is paid, not by a transfer.
      const slice = await models.Transaction.findAll({
        where: { HostCollectiveId: deductionHost.id, CollectiveId: platformTipsAccount.id },
      });
      expect(slice.every(t => t.kind === TransactionKind.PLATFORM_TIP)).to.be.true;
    });

    it('flips the held tip and the refund deduction settlements to INVOICED', async () => {
      expect((await models.TransactionSettlement.getByTransaction(heldTipCredit)).status).to.equal('INVOICED');
      expect((await models.TransactionSettlement.getByTransaction(refundTipDebit)).status).to.equal('INVOICED');
    });

    it('rolls everything forward when refund deductions exceed held tips', async () => {
      // negative-net host's only activity is a refunded already-invoiced tip, so this run nets
      // negative: no settlement expense is billed against platform-tips for it.
      const expenses = await models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: negativeNetHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });
      expect(expenses, 'no settlement expense should be billed').to.have.length(0);

      // The deduction stays OWED so it nets against a later run
      expect((await models.TransactionSettlement.getByTransaction(negativeNetRefundDebit)).status).to.equal('OWED');
    });

    it('matches the net-positive (deduction) host ledger snapshot', async () => {
      // Held tips (+), last month's release (-), the post-invoice refund deduction (-) and this
      // run's net release (-) should all appear, every row in the host currency, and the held tip +
      // refund deduction settlements flipped to INVOICED.
      await utils.snapshotLedger(
        [
          'kind',
          'type',
          'isDebt',
          'isRefund',
          'amount',
          'currency',
          'hostCurrency',
          'amountInHostCurrency',
          'settlementStatus',
        ],
        {
          where: {
            HostCollectiveId: deductionHost.id,
            kind: [TransactionKind.PLATFORM_TIP],
          },
          order: [['id', 'ASC']],
        },
      );
    });

    it('matches the negative-net (rolled-forward) host ledger snapshot', async () => {
      // Refund deductions exceed held tips: no new release is written and the refund deduction stays
      // OWED so it nets against a later run.
      await utils.snapshotLedger(
        [
          'kind',
          'type',
          'isDebt',
          'isRefund',
          'amount',
          'currency',
          'hostCurrency',
          'amountInHostCurrency',
          'settlementStatus',
        ],
        {
          where: {
            HostCollectiveId: negativeNetHost.id,
            kind: [TransactionKind.PLATFORM_TIP],
          },
          order: [['id', 'ASC']],
        },
      );
    });
  });

  describe('host that opted out of NEW_PLATFORM_TIPS_LEDGER before the settlement run', () => {
    // The flag only routes tips at collection time; settlement is decided from the vendor ledger.
    // Tips collected while the flag was on must still be invoiced and released after the host
    // opts out mid-month — otherwise their settlements stay OWED forever and the vendor slice is
    // never emptied.
    let optedOutHost, platformTipsAccount, platformTipCredit;

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 2000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 50`);

      const hostAdmin = await fakeUser();
      optedOutHost = await fakeHost({
        name: 'opted-out-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: optedOutHost.id, service: 'transferwise' });
      const collective = await fakeCollective({
        HostCollectiveId: optedOutHost.id,
        currency: 'USD',
        hostFeePercent: 0,
      });

      // Collect a $50 tip while the flag is on...
      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      try {
        const order = await fakeOrder({
          description: 'Contribution with $50 tip before opting out',
          CollectiveId: collective.id,
          currency: 'USD',
          status: 'PENDING',
          platformTipAmount: 5000,
          totalAmount: 15000,
        });
        await order.markAsPaid(hostAdmin);
      } finally {
        clock.restore();
      }

      platformTipsAccount = await models.Collective.findOne({ where: { data: { isPlatformTipsAccount: true } } });

      platformTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: optedOutHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
        },
      });
      expect(platformTipCredit, 'PLATFORM_TIP credit should be held on the vendor').to.exist;

      // ...then opt out before the settlement cron runs
      await optedOutHost.update({ settings: { ...optedOutHost.settings, newPlatformTipsLedger: false } });

      await invoicePlatformFees();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('still invoices the tips collected while the flag was on', async () => {
      const expenses = await models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: optedOutHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });
      expect(expenses, 'exactly one SETTLEMENT expense billed against platform-tips').to.have.length(1);
      const items = await expenses[0].getItems();
      const platformTipsItem = items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.amount).to.equal(5000);
      expect((await models.TransactionSettlement.getByTransaction(platformTipCredit)).status).to.equal('INVOICED');
    });
  });

  describe('NEW_PLATFORM_TIPS_LEDGER host carrying a pre-conversion legacy refund deduction', () => {
    // A tip refunded after it was invoiced under the LEGACY flow leaves a negative OWED
    // PLATFORM_TIP_DEBT row on the host's own collective. New-flow tips are now billed separately
    // (against the platform-tips account), so the legacy deduction is no longer netted into the same
    // expense: it stays on the host's legacy bundle and, with no offsetting legacy tips, rolls
    // forward (stays OWED) while the new-flow tip is billed in full against platform-tips.
    let mixedHost, platformTipsAccount, legacyRefundDebit, legacyOriginalDebtCredit, heldTipCredit;

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 2000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 50`);

      const hostAdmin = await fakeUser();
      mixedHost = await fakeHost({
        name: 'mixed-legacy-new-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: mixedHost.id, service: 'transferwise' });
      const collective = await fakeCollective({ HostCollectiveId: mixedHost.id, currency: 'USD', hostFeePercent: 0 });

      // Legacy-era $20 tip, invoiced/settled, then refunded — the exact state the conversion
      // script leaves behind (it skips refunded and non-OWED tips). Original debt: SETTLED.
      const legacyGroup = fakeUUID('10000001');
      legacyOriginalDebtCredit = await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: oc.id,
        CollectiveId: mixedHost.id,
        HostCollectiveId: mixedHost.id,
        amount: 2000,
        amountInHostCurrency: 2000,
        currency: 'USD',
        hostCurrency: 'USD',
        kind: TransactionKind.PLATFORM_TIP_DEBT,
        createdAt: twoMonthsAgo,
        isDebt: true,
        TransactionGroup: legacyGroup,
      });
      await models.TransactionSettlement.createForTransaction(legacyOriginalDebtCredit, 'SETTLED');
      // The refund pair's debt row: negative, OWED — must be deducted from the next invoice.
      legacyRefundDebit = await fakeTransaction({
        type: 'DEBIT',
        FromCollectiveId: oc.id,
        CollectiveId: mixedHost.id,
        HostCollectiveId: mixedHost.id,
        amount: -2000,
        amountInHostCurrency: -2000,
        currency: 'USD',
        hostCurrency: 'USD',
        kind: TransactionKind.PLATFORM_TIP_DEBT,
        createdAt: lastMonth,
        isDebt: true,
        isRefund: true,
        TransactionGroup: fakeUUID('10000002'),
      });
      await models.TransactionSettlement.createForTransaction(legacyRefundDebit);

      // New-flow $50 tip held on the platform-tips account.
      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      try {
        const order = await fakeOrder({
          description: 'Contribution with $50 tip on converted host',
          CollectiveId: collective.id,
          currency: 'USD',
          status: 'PENDING',
          platformTipAmount: 5000,
          totalAmount: 15000,
        });
        await order.markAsPaid(hostAdmin);
      } finally {
        clock.restore();
      }

      platformTipsAccount = await models.Collective.findOne({ where: { data: { isPlatformTipsAccount: true } } });

      heldTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: mixedHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
        },
      });
      expect(heldTipCredit, 'PLATFORM_TIP credit should be held on the vendor').to.exist;

      await invoicePlatformFees();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('bills the new-flow tips against platform-tips and rolls the legacy deduction forward', async () => {
      const platformTipsExpenses = await models.Expense.findAll({
        where: { CollectiveId: platformTipsAccount.id, HostCollectiveId: mixedHost.id, type: ExpenseType.SETTLEMENT },
      });
      expect(platformTipsExpenses, 'one platform-tips settlement expense').to.have.length(1);
      const items = await platformTipsExpenses[0].getItems();
      const platformTipsItem = items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.amount).to.equal(5000); // the new-flow held tip, billed in full

      // No host-billed settlement expense is created for the negative-only legacy bundle.
      const hostExpenses = await mixedHost.getExpenses();
      expect(hostExpenses, 'no host-billed expense for a negative-only legacy bundle').to.have.length(0);
    });

    it('writes no release transfer (only the held PLATFORM_TIP credit sits on the slice)', async () => {
      const slice = await models.Transaction.findAll({
        where: { HostCollectiveId: mixedHost.id, CollectiveId: platformTipsAccount.id },
      });
      expect(slice.every(t => t.kind === TransactionKind.PLATFORM_TIP)).to.be.true;
    });

    it('flips the held new-flow tip to INVOICED and leaves the legacy rows untouched', async () => {
      expect((await models.TransactionSettlement.getByTransaction(heldTipCredit)).status).to.equal('INVOICED');
      // The legacy refund deduction has no positive legacy tips to net against this run -> stays OWED.
      expect((await models.TransactionSettlement.getByTransaction(legacyRefundDebit)).status).to.equal('OWED');
      expect((await models.TransactionSettlement.getByTransaction(legacyOriginalDebtCredit)).status).to.equal(
        'SETTLED',
      );
    });
  });

  describe('NEW_PLATFORM_TIPS_LEDGER host with non-USD currency', () => {
    // A new-ledger PLATFORM_TIP credit lives on the host's ledger, so it is denominated in the
    // host's currency (not the platform currency). For a EUR host collecting a 300€ tip the credit
    // is recorded as 300€ directly — no EUR->USD->EUR round trip. The host is therefore billed
    // exactly what it collected, and the platform-tips account balance for the host nets to zero once
    // the tip is released at settlement.
    let eurLedgerHost, platformTipsAccount, platformTipCredit, settlementExpense;
    const TIP_EUR = 300e2;

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 3000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 80`);

      const hostAdmin = await fakeUser();
      eurLedgerHost = await fakeHost({
        name: 'eur-ledger-host',
        currency: 'EUR',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: eurLedgerHost.id, service: 'transferwise' });

      const collective = await fakeCollective({ HostCollectiveId: eurLedgerHost.id, currency: 'EUR' });

      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      const order = await fakeOrder({
        description: 'EUR contribution with 300€ tip on new-ledger host',
        CollectiveId: collective.id,
        currency: 'EUR',
        status: 'PENDING',
        platformTipAmount: TIP_EUR,
        totalAmount: 1300e2,
      });
      await order.markAsPaid(hostAdmin);
      clock.restore();

      platformTipsAccount = await models.Collective.findOne({ where: { data: { isPlatformTipsAccount: true } } });

      platformTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: eurLedgerHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
        },
      });
      // The credit is on the host's ledger (HostCollectiveId = host, not null) and denominated in
      // the host's currency (EUR), recorded directly with no platform-currency round trip.
      expect(platformTipCredit.HostCollectiveId).to.equal(eurLedgerHost.id);
      expect(platformTipCredit.hostCurrency).to.equal('EUR');
      expect(platformTipCredit.amountInHostCurrency).to.equal(TIP_EUR);

      await invoicePlatformFees();

      const settlementExpenses = await models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: eurLedgerHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });
      expect(settlementExpenses, 'cron should bill one SETTLEMENT expense against platform-tips').to.have.length(1);
      settlementExpense = settlementExpenses[0];
      settlementExpense.items = await settlementExpense.getItems();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('bills the Platform Tips item for exactly the collected tip, in the host currency', () => {
      expect(settlementExpense.currency).to.equal('EUR');
      const platformTipsItem = settlementExpense.items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.currency).to.equal('EUR');
      expect(platformTipsItem.amount).to.equal(TIP_EUR); // exactly what was collected — no round trip
    });

    it('bills against platform-tips in the host currency and writes no release transfer', async () => {
      expect(settlementExpense.CollectiveId).to.equal(platformTipsAccount.id);
      expect(settlementExpense.HostCollectiveId).to.equal(eurLedgerHost.id);
      expect(settlementExpense.currency).to.equal('EUR');
      expect(settlementExpense.amount).to.equal(TIP_EUR);

      // The held EUR credit stays on the slice (no transfer); it clears when the expense is paid.
      const slice = await models.Transaction.findAll({
        where: { CollectiveId: platformTipsAccount.id, HostCollectiveId: eurLedgerHost.id },
      });
      expect(slice.map(t => t.kind)).to.deep.equal([TransactionKind.PLATFORM_TIP]);
      expect(slice[0].hostCurrency).to.equal('EUR');
      expect(slice[0].amountInHostCurrency).to.equal(TIP_EUR);
    });

    it('matches the EUR host ledger snapshot (no platform-currency round trip)', async () => {
      // The platform-tip ledger for a EUR host stays in EUR: the held PLATFORM_TIP credit is recorded
      // as 300€ directly, with no EUR->USD->EUR detour. This snapshot guards that denomination.
      await utils.snapshotLedger(
        ['kind', 'type', 'isDebt', 'amount', 'currency', 'hostCurrency', 'amountInHostCurrency', 'settlementStatus'],
        {
          where: {
            HostCollectiveId: eurLedgerHost.id,
            kind: [TransactionKind.PLATFORM_TIP],
          },
          order: [['id', 'ASC']],
        },
      );
    });
  });

  describe('NEW_PLATFORM_TIPS_LEDGER host below the settlement threshold', () => {
    // Regression: when the run is skipped (here because totalAmountChargedInUsd < MIN_AMOUNT_USD),
    // no settlement expense may be created and the source PLATFORM_TIP TransactionSettlement rows must
    // stay OWED, so they are simply retried on a later run rather than billed below the threshold.
    let belowThresholdHost, platformTipsAccount, platformTipCredit;
    const SMALL_TIP = 300; // $3, well under the $10 minimum

    const platformTipsExpenses = () =>
      models.Expense.findAll({
        where: {
          CollectiveId: platformTipsAccount.id,
          HostCollectiveId: belowThresholdHost.id,
          type: ExpenseType.SETTLEMENT,
        },
      });

    before(async () => {
      await utils.resetTestDB();
      await utils.seedDefaultVendors();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 4000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 110`);

      const hostAdmin = await fakeUser();
      belowThresholdHost = await fakeHost({
        name: 'below-threshold-ledger-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        admin: hostAdmin,
        settings: { newPlatformTipsLedger: true },
      });
      await fakeConnectedAccount({ CollectiveId: belowThresholdHost.id, service: 'transferwise' });

      const collective = await fakeCollective({ HostCollectiveId: belowThresholdHost.id, currency: 'USD' });

      const clock = useFakeTimers({ now: lastMonth.toDate(), toFake: ['Date'] });
      const order = await fakeOrder({
        description: 'Contribution with a $3 tip on new-ledger host',
        CollectiveId: collective.id,
        currency: 'USD',
        status: 'PENDING',
        platformTipAmount: SMALL_TIP,
        totalAmount: 5000,
      });
      await order.markAsPaid(hostAdmin);
      clock.restore();

      platformTipsAccount = await models.Collective.findOne({ where: { data: { isPlatformTipsAccount: true } } });

      platformTipCredit = await models.Transaction.findOne({
        where: {
          HostCollectiveId: belowThresholdHost.id,
          CollectiveId: platformTipsAccount.id,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
        },
      });
      expect(platformTipCredit, 'PLATFORM_TIP credit should be written on the platform-tips account').to.exist;
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('does not bill an expense and leaves the TransactionSettlement OWED when skipped', async () => {
      await invoicePlatformFees();

      expect(await platformTipsExpenses(), 'no settlement expense below threshold').to.have.length(0);
      const ts = await models.TransactionSettlement.getByTransaction(platformTipCredit);
      expect(ts.status, 'source tip stays OWED so it is retried later').to.equal('OWED');
    });

    it('is idempotent across repeated skipped runs', async () => {
      // Repeated below-threshold runs must not bill anything or flip the settlement: the tip simply
      // keeps rolling forward until it clears the minimum.
      await invoicePlatformFees();
      await invoicePlatformFees();

      expect(await platformTipsExpenses(), 'still no expense after repeated skipped runs').to.have.length(0);
      const ts = await models.TransactionSettlement.getByTransaction(platformTipCredit);
      expect(ts.status).to.equal('OWED');
    });
  });

  describe('settlement guards', () => {
    let ociHost, ociTipDebtCredit, softDeletedTsHost, fixedFeeOnlyHost;

    before(async () => {
      await utils.resetTestDB();

      const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
      const oc = await fakeHost({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
        CreatedByUserId: platformUser.id,
      });
      await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
      // The cron requires a USD BANK_ACCOUNT payout method on the platform org.
      await fakePayoutMethod({
        CollectiveId: oc.id,
        type: 'BANK_ACCOUNT',
        data: { details: {}, type: 'IBAN', accountHolderName: 'OpenCollective Inc.', currency: 'USD' },
      });

      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 3000`);
      await sequelize.query(`ALTER SEQUENCE "Users_id_seq" RESTART WITH 70`);

      // 1) OC Inc (the pre-2024 platform account): only the current platform accounts are excluded
      // from settlements, so OC Inc is billed like any other host.
      ociHost = await fakeHost({ id: PlatformConstants.OCICollectiveId, name: 'OC Inc', currency: 'USD' });
      await fakeConnectedAccount({ CollectiveId: ociHost.id, service: 'transferwise' });
      ociTipDebtCredit = await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: oc.id,
        CollectiveId: ociHost.id,
        HostCollectiveId: ociHost.id,
        amount: 2000,
        amountInHostCurrency: 2000,
        currency: 'USD',
        hostCurrency: 'USD',
        kind: TransactionKind.PLATFORM_TIP_DEBT,
        createdAt: lastMonth,
        isDebt: true,
      });
      await models.TransactionSettlement.createForTransaction(ociTipDebtCredit);

      // 2) Host with one live and one soft-deleted OWED settlement: only the live one may be billed.
      softDeletedTsHost = await fakeHost({ name: 'soft-deleted-ts-host', currency: 'USD' });
      await fakeConnectedAccount({ CollectiveId: softDeletedTsHost.id, service: 'transferwise' });
      const liveTipDebtCredit = await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: oc.id,
        CollectiveId: softDeletedTsHost.id,
        HostCollectiveId: softDeletedTsHost.id,
        amount: 2000,
        amountInHostCurrency: 2000,
        currency: 'USD',
        hostCurrency: 'USD',
        kind: TransactionKind.PLATFORM_TIP_DEBT,
        createdAt: lastMonth,
        isDebt: true,
      });
      await models.TransactionSettlement.createForTransaction(liveTipDebtCredit);
      const deletedTipDebtCredit = await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: oc.id,
        CollectiveId: softDeletedTsHost.id,
        HostCollectiveId: softDeletedTsHost.id,
        amount: 1500,
        amountInHostCurrency: 1500,
        currency: 'USD',
        hostCurrency: 'USD',
        kind: TransactionKind.PLATFORM_TIP_DEBT,
        createdAt: lastMonth,
        isDebt: true,
      });
      await models.TransactionSettlement.createForTransaction(deletedTipDebtCredit);
      const tsToDelete = await models.TransactionSettlement.getByTransaction(deletedTipDebtCredit);
      await tsToDelete.destroy();

      // 3) Host whose settlement expense carries only non-transaction items (Fixed Fee per Hosted
      // Collective): the CSV attachment must be skipped instead of emitting an empty `kind=` param.
      fixedFeeOnlyHost = await fakeHost({
        name: 'fixed-fee-only-host',
        currency: 'USD',
        plan: 'grow-plan-2021',
        data: { plan: { pricePerCollective: 1200 } },
      });
      await fakeConnectedAccount({ CollectiveId: fixedFeeOnlyHost.id, service: 'transferwise' });
      const hostedCollective = await fakeCollective({ HostCollectiveId: fixedFeeOnlyHost.id });
      // Some activity in the period so the host is picked up, but no OWED debt rows.
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: hostedCollective.id,
        HostCollectiveId: fixedFeeOnlyHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        createdAt: lastMonth,
      });

      await invoicePlatformFees();
    });

    after(async () => {
      await utils.resetTestDB();
    });

    it('invoices OC Inc like any other host, only current platform accounts are excluded', async () => {
      const expenses = await ociHost.getExpenses();
      expect(expenses, 'one settlement expense for OC Inc').to.have.length(1);
      const ts = await models.TransactionSettlement.getByTransaction(ociTipDebtCredit);
      expect(ts.status, 'OC Inc tip debt is invoiced').to.equal('INVOICED');
    });

    it('does not bill soft-deleted settlements', async () => {
      const expenses = await softDeletedTsHost.getExpenses();
      expect(expenses, 'one settlement expense').to.have.length(1);
      const items = await expenses[0].getItems();
      const platformTipsItem = items.find(i => i.description === 'Platform Tips');
      expect(platformTipsItem, 'expense should have a Platform Tips item').to.exist;
      expect(platformTipsItem.amount, 'only the live settlement is billed').to.equal(2000);
    });

    it('skips the CSV attachment when the expense has no transaction-backed items', async () => {
      const expenses = await fixedFeeOnlyHost.getExpenses();
      expect(expenses, 'one settlement expense').to.have.length(1);
      const items = await expenses[0].getItems();
      expect(items.map(i => i.description)).to.deep.equal(['Fixed Fee per Hosted Collective']);
      const attachedFiles = await models.ExpenseAttachedFile.findAll({ where: { ExpenseId: expenses[0].id } });
      expect(attachedFiles, 'no CSV attachment without transactions').to.have.length(0);
    });
  });
});
