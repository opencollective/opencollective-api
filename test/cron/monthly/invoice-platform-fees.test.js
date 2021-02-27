import { expect } from 'chai';
import moment from 'moment';

import { run as invoicePlatformFees } from '../../../cron/monthly/invoice-platform-fees';
import { sequelize } from '../../../server/models';
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

describe('cron/monthly/invoice-platform-fees', () => {
  const lastMonth = moment.utc().subtract(1, 'month');

  let gbpHost, expense;
  before(async () => {
    await utils.resetTestDB();
    const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
    const oc = await fakeHost({ id: 8686, slug: 'opencollective', CreatedByUserId: user.id });

    // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
    await sequelize.query(`ALTER SEQUENCE "Collectives_id_seq" RESTART WITH 1453`);
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
      CollectiveId: socialCollective.id,
      currency: 'GBP',
      hostCurrency: 'GBP',
      HostCollectiveId: gbpHost.id,
      createdAt: lastMonth,
    };
    // Create Platform Fees
    await fakeTransaction({
      ...transactionProps,
      amount: 3000,
      platformFeeInHostCurrency: -300,
      hostFeeInHostCurrency: -300,
    });
    await fakeTransaction({
      ...transactionProps,
      amount: 3000,
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: -200,
    });
    await fakeTransaction({
      ...transactionProps,
      amount: 3000,
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: -300,
      data: {
        settled: true,
      },
    });
    // Add Platform Tips
    const t = await fakeTransaction(transactionProps);
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      amount: 1000,
      currency: 'USD',
      data: { hostToPlatformFxRate: 1.23 },
      PlatformTipForTransactionGroup: t.TransactionGroup,
      createdAt: lastMonth,
    });
    // Collected Platform Tip with pending Payment Processor Fee
    const t2 = await fakeTransaction(transactionProps);
    const paymentMethod = await fakePaymentMethod({ service: 'stripe', token: 'tok_bypassPending' });
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: oc.id,
      amount: 1000,
      currency: 'USD',
      data: { hostToPlatformFxRate: 1.23 },
      PlatformTipForTransactionGroup: t2.TransactionGroup,
      paymentProcessorFeeInHostCurrency: -100,
      PaymentMethodId: paymentMethod.id,
      createdAt: lastMonth,
    });

    await invoicePlatformFees();

    expense = (await gbpHost.getExpenses())[0];
    expense.items = await expense.getItems();
  });

  // Resync DB to make sure we're not touching other tests
  after(async () => {
    await utils.resetTestDB();
  });

  it('should credit the host with the total amount collected in platform fees', async () => {
    const [collectedTransaction] = await gbpHost.getTransactions({});
    expect(collectedTransaction).to.have.property('description').that.includes('Platform Fees and Tips collected in');
    expect(collectedTransaction).to.have.property('amount', Math.round(1000 / 1.23) + 300);
  });

  it('should invoice the host in its own currency', () => {
    expect(expense).to.have.property('currency', 'GBP');
    expect(expense).to.have.property('description').that.includes('Platform settlement for');
    expect(expense).to.have.nested.property('data.isPlatformTipSettlement', true);
  });

  it('should use a payout method compatible with the host currency', () => {
    expect(expense).to.have.property('PayoutMethodId', 2956);
  });

  it('should invoice platform fees not collected through Stripe', async () => {
    const platformFeesItem = expense.items.find(p => p.description == 'Platform Fees');
    expect(platformFeesItem).to.have.property('amount', 300);
  });

  it('should invoice platform tips not collected through Stripe', async () => {
    const platformTipsItem = expense.items.find(p => p.description == 'Platform Tips');
    expect(platformTipsItem).to.have.property('amount', Math.round(1000 / 1.23));
  });

  it('should invoice pending shared host revenue and ignore settled transactions and transactions with platform fee', async () => {
    const sharedRevenueItem = expense.items.find(p => p.description == 'Shared Revenue');
    expect(sharedRevenueItem).to.have.property('amount', Math.round(200 * 0.15));
  });

  it('should attach detailed list of transactions in the expense', async () => {
    const [attachment] = await expense.getAttachedFiles();
    expect(attachment).to.have.property('url').that.includes('.csv');
  });

  it('should deduct owed payment processor fees relatetd to platform tips collected using stripe', async () => {
    const reimburseItem = expense.items.find(
      p => p.description == 'Reimburse: Payment Processor Fee for collected Platform Tips',
    );
    expect(reimburseItem).to.have.property('amount', Math.round(-100 / 1.23));
  });

  it('should consider fixed fee per host collective', async () => {
    const reimburseItem = expense.items.find(p => p.description == 'Fixed Fee per Hosted Collective');
    expect(reimburseItem).to.have.property('amount', 100);
  });
});
