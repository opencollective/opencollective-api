import { expect } from 'chai';
import moment from 'moment';
import sinon, { useFakeTimers } from 'sinon';

import { run as invoicePlatformFees } from '../../../cron/monthly/host-settlement';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { createRefundTransaction } from '../../../server/lib/payments';
import { getTaxesSummary } from '../../../server/lib/transactions';
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
    eurCollective,
    gphHostSettlementExpense,
    eurHostSettlementExpense,
    newHostSettlementExpense,
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
});
