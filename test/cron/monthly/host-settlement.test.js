import { expect } from 'chai';
import moment from 'moment';

import { run as invoicePlatformFees } from '../../../cron/monthly/host-settlement';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import models, { sequelize } from '../../../server/models';
import { TransactionSettlementStatus } from '../../../server/models/TransactionSettlement';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/monthly/host-settlement', () => {
  const lastMonth = moment.utc().subtract(1, 'month');

  let gbpHost, expense;
  before(async () => {
    await utils.resetTestDB(); // We're relying on IDs
    const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
    const oc = await fakeHost({ id: 8686, slug: 'opencollective', CreatedByUserId: user.id });

    // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
    await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 1453`);
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
    });
    const contribution2 = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -400,
    });
    const contribution3 = await fakeTransaction({
      ...transactionProps,
      kind: TransactionKind.CONTRIBUTION,
      amount: 3000,
      hostFeeInHostCurrency: -600,
    });
    // Create host fee share
    const hostFeeResults = await Promise.all(
      [contribution1, contribution2, contribution3].map(transaction =>
        models.Transaction.createHostFeeTransactions(transaction, gbpHost),
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
    const t = await fakeTransaction(transactionProps);
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      HostCollectiveId: oc.id,
      amount: 1000,
      currency: 'USD',
      data: { hostToPlatformFxRate: 1.23 },
      TransactionGroup: t.TransactionGroup,
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
      TransactionGroup: t.TransactionGroup,
      kind: TransactionKind.PLATFORM_TIP_DEBT,
      createdAt: lastMonth,
      isDebt: true,
    });
    await models.TransactionSettlement.createForTransaction(firstTipDebtCredit);

    // Collected Platform Tip with pending Payment Processor Fee. No debt here, it's collected directly via Stripe
    const t2 = await fakeTransaction(transactionProps);
    const paymentMethod = await fakePaymentMethod({ service: 'stripe', token: 'tok_bypassPending' });
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      HostCollectiveId: oc.id,
      amount: 813,
      amountInHostCurrency: 813,
      hostCurrency: 'GBP',
      data: { hostToPlatformFxRate: 1.23 },
      TransactionGroup: t2.TransactionGroup,
      kind: TransactionKind.PLATFORM_TIP,
      paymentProcessorFeeInHostCurrency: -100,
      PaymentMethodId: paymentMethod.id,
      createdAt: lastMonth,
    });

    await invoicePlatformFees();

    expense = (await gbpHost.getExpenses())[0];
    expect(expense).to.exist;
    expense.items = await expense.getItems();
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
    expect(sharedRevenueItem).to.have.property('amount', Math.round(1600 * 0.15));
  });

  it('should attach detailed list of transactions in the expense', async () => {
    const [attachment] = await expense.getAttachedFiles();
    expect(attachment).to.have.property('url').that.includes('.csv');
  });

  it('should consider fixed fee per host collective', async () => {
    const reimburseItem = expense.items.find(p => p.description === 'Fixed Fee per Hosted Collective');
    expect(reimburseItem).to.have.property('amount', 100);
  });

  it('should update settlementStatus to INVOICED', async () => {
    const settlements = await models.TransactionSettlement.findAll();
    expect(settlements.length).to.eq(4); // 1 Platform tip + 3 host fee share
    settlements.forEach(settlement => {
      expect(settlement.status).to.eq(TransactionSettlementStatus.INVOICED);
    });
  });
});
