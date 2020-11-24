import { expect } from 'chai';
import moment from 'moment';

import { run as invoicePlatformFees } from '../../../cron/monthly/invoice-platform-fees';
import { sequelize } from '../../../server/models';
import {
  fakeCollective,
  fakeHost,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  multiple,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/monthly/invoice-platform-fees', () => {
  const lastMonth = moment.utc().subtract(1, 'month');

  let gbpHost, expense;
  before(async () => {
    await utils.resetTestDB();
    const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
    const inc = await fakeHost({ id: 8686, slug: 'opencollectiveinc', CreatedByUserId: user.id });
    const opencollective = await fakeCollective({
      id: 1,
      slug: 'opencollective',
      CreatedByUserId: user.id,
      HostCollectiveId: inc.id,
    });
    // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
    await sequelize.query(`ALTER SEQUENCE "Collectives_id_seq" RESTART WITH 1453`);
    await fakePayoutMethod({
      id: 2955,
      CollectiveId: opencollective.id,
      type: 'BANK_ACCOUNT',
    });

    gbpHost = await fakeHost({ currency: 'GBP' });

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
    });
    // Add Platform Tips
    const t = await fakeTransaction(transactionProps);
    await fakeTransaction({
      type: 'CREDIT',
      CollectiveId: opencollective.id,
      amount: 100,
      currency: 'USD',
      data: { hostToPlatformFxRate: 1.23 },
      PlatformTipForTransactionGroup: t.TransactionGroup,
      createdAt: lastMonth,
    });

    // Add some noise...
    multiple(fakeTransaction, 5, {
      ...transactionProps,
    });

    await invoicePlatformFees();

    expense = (await gbpHost.getExpenses())[0];
    expense.items = await expense.getItems();
  });

  it('should credit the host with the total amount collected in platform fees', async () => {
    const [collectedTransaction] = await gbpHost.getTransactions({});
    expect(collectedTransaction).to.have.property('description').that.includes('Platform Fees and Tips collected in');
    expect(collectedTransaction).to.have.property('amount', Math.round(100 / 1.23) + 300);
  });

  it('should invoice the host in its own currency', () => {
    expect(expense).to.have.property('currency', 'GBP');
    expect(expense).to.have.property('description').that.includes('Platform settlement for');
    expect(expense).to.have.nested.property('data.isPlatformTipSettlement', true);
  });

  it('should invoice platform fees not collected through Stripe', async () => {
    const platformFeesItem = expense.items.find(p => p.description == 'Platform Fees');
    expect(platformFeesItem).to.have.property('amount', 300);
  });

  it('should invoice platform tips not collected through Stripe', async () => {
    const platformTipsItem = expense.items.find(p => p.description == 'Platform Tips');
    expect(platformTipsItem).to.have.property('amount', Math.round(100 / 1.23));
  });

  it('should attach detailed list of transactions in the expense', async () => {
    const [attachment] = await expense.getAttachedFiles();
    expect(attachment).to.have.property('url').that.includes('.csv');
  });
});
