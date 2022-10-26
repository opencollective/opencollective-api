import { expect } from 'chai';
import { pick } from 'lodash';

import { Service } from '../../../../server/constants/connected_account';
import { checkExpense } from '../../../../server/lib/security/expense';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
  multiple,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const snapshotChecks = checks => checks.map(c => pick(c, ['scope', 'level', 'message']));

describe('lib/security/expense', () => {
  before(resetTestDB);

  before(async () => {
    await multiple(fakeExpense, 10, {});
  });

  describe('checkExpense()', () => {
    it('returns potential threats related to the expense payment', async () => {
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
        service: Service.TWITTER,
        username: 'dude',
        CollectiveId: otherUser.collective.id,
      });
      await ca.update({
        CollectiveId: user.collective.id,
      });

      const expense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });
      const checks = await checkExpense(expense);
      expect(snapshotChecks(checks)).to.matchTableSnapshot();
    });
  });
});
