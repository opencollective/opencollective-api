import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { run as invoicePlatformFees } from '../../../cron/monthly/host-settlement';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { refundTransaction } from '../../../server/lib/payments';
import models, { sequelize } from '../../../server/models';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  fakeUUID,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/monthly/host-settlement', () => {
  const lastMonth = moment.utc().subtract(1, 'month');

  let gbpHost, expense, settledRefundedContribution, unsettledRefundedContribution;
  before(async () => {
    await utils.resetTestDB();
    const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
    const oc = await fakeHost({ id: 8686, slug: 'opencollective', CreatedByUserId: user.id });

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
    await fakePayoutMethod({
      ...payoutProto,
      id: 2955,
    });
    await fakePayoutMethod({
      ...payoutProto,
      id: 2956,
      data: { ...payoutProto.data, currency: 'GBP' },
    });

    gbpHost = await fakeHost({ currency: 'GBP', plan: 'grow-plan-2021', data: { plan: { pricePerCollective: 100 } } });
    await fakeConnectedAccount({ CollectiveId: gbpHost.id, service: 'transferwise' });

    const socialCollective = await fakeCollective({ HostCollectiveId: gbpHost.id });
    const transactionProps = {
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: socialCollective.id,
      currency: 'GBP',
      hostCurrency: 'GBP',
      HostCollectiveId: gbpHost.id,
      createdAt: lastMonth,
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
    unsettledRefundedContribution = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -600,
      TransactionGroup: fakeUUID('00000004'),
    });
    settledRefundedContribution = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 4200,
      hostFeeInHostCurrency: -420,
      createdAt: lastMonth.subtract(1, 'month'),
      TransactionGroup: fakeUUID('00000005'),
    });

    // Create host fee share
    const hostFeeResults = await Promise.all(
      [contribution1, contribution2, contribution3, unsettledRefundedContribution, settledRefundedContribution].map(
        transaction => models.Transaction.createHostFeeTransactions(transaction, gbpHost),
      ),
    );

    await Promise.all(
      hostFeeResults.map(({ transaction, hostFeeTransaction }) =>
        models.Transaction.createHostFeeShareTransactions(
          { transaction: transaction, hostFeeTransaction: hostFeeTransaction },
          gbpHost,
          false,
        ),
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
    const clock = sinon.useFakeTimers(lastMonth.add(1, 'day').toDate());
    await refundTransaction(unsettledRefundedContribution, user, null, { TransactionGroup: fakeUUID('00000008') });
    await refundTransaction(settledRefundedContribution, user, null, { TransactionGroup: fakeUUID('00000009') });
    clock.restore();

    await invoicePlatformFees();

    expense = (await gbpHost.getExpenses())[0];
    expect(expense).to.exist;
    expense.items = await expense.getItems();
  });

  // Resync DB to make sure we're not touching other tests
  after(async () => {
    await utils.resetTestDB();
  });

  it('should invoice the host in its own currency', () => {
    expect(expense).to.have.property('currency', 'GBP');
    expect(expense).to.have.property('description').that.includes('Platform settlement for');
    expect(expense).to.have.nested.property('data.isPlatformTipSettlement', true);
  });

  it('should use a payout method compatible with the host currency', () => {
    expect(expense).to.have.property('PayoutMethodId', 2956);
  });

  it('should invoice platform tips not collected through Stripe', async () => {
    const platformTipsItem = expense.items.find(p => p.description === 'Platform Tips');
    expect(platformTipsItem).to.have.property('amount', Math.round(1000 / 1.23));
  });

  it('should invoice pending shared host revenue', async () => {
    const sharedRevenueItem = expense.items.find(p => p.description === 'Shared Revenue');
    const expectedRevenue = Math.round(1600 * 0.15);
    const expectedRefund = Math.round(420 * 0.15);
    expect(sharedRevenueItem).to.have.property('amount', expectedRevenue - expectedRefund);
  });

  it('should attach detailed list of transactions in the expense', async () => {
    const [attachment] = await expense.getAttachedFiles();
    expect(attachment).to.have.property('url').that.includes('.csv');
  });

  it('should consider fixed fee per host collective', async () => {
    const reimburseItem = expense.items.find(p => p.description === 'Fixed Fee per Hosted Collective');
    expect(reimburseItem).to.have.property('amount', 100);
  });

  it('should update all settlement status', async () => {
    const countSettlements = status => models.TransactionSettlement.count({ where: { status } });
    await utils.snapshotLedger(['TransactionGroup', 'kind', 'type', 'amount', 'isRefund', 'settlementStatus'], {
      where: { isDebt: true },
      order: [
        ['TransactionGroup', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    expect(await countSettlements('INVOICED')).to.eq(5); // 1 Platform tip + 3 host fee share + 1 host fee share refund
    expect(await countSettlements('SETTLED')).to.eq(3); // (Host fee share + Host fee share refund) for unsettledRefundedContribution + host fee share for settledRefundedContribution
  });
});
