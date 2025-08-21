import { expect } from 'chai';
import { pick } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import { run } from '../../../cron/monthly/submit-platform-subscription-bills';
import { expenseTypes } from '../../../server/constants';
import { CollectiveType } from '../../../server/constants/collectives';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import PlatformConstants from '../../../server/constants/platform';
import models, { PlatformSubscription } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('submit-platform-subscription-bills', () => {
  const date = moment.utc('2023-10-09T10:00:00Z');
  const sandbox = sinon.createSandbox();

  let organizations;
  before(async () => {
    await resetTestDB();
    const user = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: user.id,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
    const payoutProto = {
      data: {
        details: {},
        type: 'IBAN',
        accountHolderName: 'OpenCollective Inc.',
        currency: 'USD',
      },
      CollectiveId: oc.id,
      type: PayoutMethodTypes.BANK_ACCOUNT,
    };
    await fakePayoutMethod({
      ...payoutProto,
      id: 2955,
      isSaved: true,
    });

    // ocStripePayoutMethod = (await oc.getPayoutMethods()).find(pm => pm.type === PayoutMethodTypes.STRIPE);
    organizations = [];
    for (let i = 0; i < 5; i++) {
      organizations.push(await fakeCollective({ type: CollectiveType.ORGANIZATION, isActive: true }));
    }

    const plans = [
      PlatformSubscriptionTiers[0],
      PlatformSubscriptionTiers[1],
      PlatformSubscriptionTiers[2],
      PlatformSubscriptionTiers[3],
      PlatformSubscriptionTiers[4],
    ];
    for (const org of organizations) {
      const i = organizations.indexOf(org);
      await PlatformSubscription.createSubscription(org, moment(date).subtract(2, 'month').toDate(), plans[i], user);
    }

    const calculateUtilizationStub = sandbox.stub(PlatformSubscription, 'calculateUtilization');
    const utilizations = [
      { activeCollectives: 0, expensesPaid: 5 },
      { activeCollectives: 5, expensesPaid: 2 },
      { activeCollectives: 4, expensesPaid: 55 },
      { activeCollectives: 20, expensesPaid: 120 },
      { activeCollectives: 30, expensesPaid: 230 },
    ];
    organizations.forEach((org, i) => {
      calculateUtilizationStub.withArgs(org.id).resolves(utilizations[i]);
    });
  });

  after(() => {
    sandbox.restore();
  });

  it('should run without errors', async () => {
    await run(date);
  });

  it('should omit bills for $0', async () => {
    const expenses = await models.Expense.findAll({
      where: { CollectiveId: organizations[0].id, type: expenseTypes.PLATFORM_BILLING },
    });

    expect(expenses).to.have.length(0);
  });

  it('should submit Expenses for active subscriptions', async () => {
    const expenses = await models.Expense.findAll({
      where: { type: expenseTypes.PLATFORM_BILLING },
      order: [['id', 'DESC']],
    });

    expect(expenses).to.have.length(4);
    const expensesTable = expenses.map(e =>
      pick(e.toJSON(), ['id', 'type', 'CollectiveId', 'description', 'amount', 'currency']),
    );
    expect(expensesTable).to.matchTableSnapshot();

    const items = await models.ExpenseItem.findAll({
      where: { ExpenseId: expenses.map(e => e.id) },
      order: [['id', 'DESC']],
    });

    const itemsTable = items.map(i => pick(i.toJSON(), ['ExpenseId', 'description', 'amount', 'currency']));
    expect(itemsTable).to.matchTableSnapshot();
  });

  it('should not bill organizations twice', async () => {
    await run(date);

    const expenses = await models.Expense.findAll({
      where: { CollectiveId: organizations[1].id, type: expenseTypes.PLATFORM_BILLING },
    });

    expect(expenses).to.have.length(1);
  });
});
