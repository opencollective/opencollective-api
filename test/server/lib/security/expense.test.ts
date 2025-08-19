import { expect } from 'chai';
import { pick } from 'lodash';

import { CollectiveType } from '../../../../server/constants/collectives';
import { Service } from '../../../../server/constants/connected-account';
import OrderStatuses from '../../../../server/constants/order-status';
import { checkExpense, checkExpensesBatch } from '../../../../server/lib/security/expense';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeOrder,
  fakePayoutMethod,
  fakeUser,
  multiple,
  randStr,
  sequelize,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

const snapshotChecks = checks => checks.map(c => pick(c, ['scope', 'level', 'message']));

describe('lib/security/expense', () => {
  before(resetTestDB);

  before(async () => {
    await multiple(fakeExpense, 10, {});
  });

  describe('checkExpense() and checkExpenses()', () => {
    let expense;
    before(async () => {
      const ip = '192.168.0.27';
      const [user] = await multiple(fakeUser, 2, { data: { lastSignInRequest: { ip } }, updatedAt: new Date() });

      // Payout Method overlap
      const [pm] = await multiple(fakePayoutMethod, 2, {
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'will@dafoe.net',
        },
      });
      await pm.update({
        CollectiveId: user.collective.id,
      });

      // Connected Accounts overlap
      const otherUser = await fakeUser();
      const [ca] = await multiple(fakeConnectedAccount, 2, {
        service: Service.GITHUB,
        username: 'dude',
        CollectiveId: otherUser.collective.id,
      });
      await ca.update({
        CollectiveId: user.collective.id,
      });

      expense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });

      // Order Error rate
      await multiple(fakeOrder, 5, { CollectiveId: expense.CollectiveId, status: OrderStatuses.ERROR });
      await multiple(fakeOrder, 5, { CollectiveId: expense.CollectiveId, status: OrderStatuses.PAID });
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveOrderStats"`);
    });

    it('does not identify user as impersonating itself', async () => {
      const ip = '192.168.0.26';
      const userSlug = randStr('user-');
      const user = await fakeUser({ data: { lastSignInRequest: { ip } }, updatedAt: new Date() }, { slug: userSlug });

      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: `${randStr('email-')}@email.com`,
        },
        CollectiveId: user.collective.id,
      });
      const expense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });
      const securityChecks = await checkExpense(expense, { req: makeRequest() as any });

      expect(securityChecks.find(s => s.message === 'This user may be impersonating multiple profiles')).to.be
        .undefined;
    });

    it('returns potential threats related to the expense payment', async () => {
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(snapshotChecks(checks)).to.matchTableSnapshot();
    });

    it('returns potential threats related to the expense payment (batch)', async () => {
      const user = await fakeUser();
      const pm = await fakePayoutMethod({
        CollectiveId: user.collective.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'nicolas@cage.com',
        },
      });
      const otherExpense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });

      const [expenseCheck, otherExpenseCheck] = await checkExpensesBatch(makeRequest() as any, [expense, otherExpense]);
      expect(await checkExpense(expense, { req: makeRequest() as any })).to.deep.equal(expenseCheck);
      expect(snapshotChecks(expenseCheck)).to.matchTableSnapshot();
      expect(snapshotChecks(otherExpenseCheck)).to.matchTableSnapshot();
    });

    it('ignores similar payout methods that belongs to VENDORs', async () => {
      const [vendor, anotherVendor] = await multiple(fakeCollective, 2, { type: CollectiveType.VENDOR });
      const pm = await fakePayoutMethod({
        CollectiveId: vendor.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'vendor@opencollective.com',
        },
      });
      await fakePayoutMethod({
        CollectiveId: anotherVendor.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'vendor@opencollective.com',
        },
      });
      const vendorExpense = await fakeExpense({ UserId: vendor.CreatedByUserId, PayoutMethodId: pm.id });

      const checks = await checkExpense(vendorExpense, { req: makeRequest() as any });
      expect(snapshotChecks(checks)).to.matchTableSnapshot();
    });
  });
});
