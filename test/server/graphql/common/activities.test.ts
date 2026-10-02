import { expect } from 'chai';
import type Express from 'express';

import ActivityTypes from '../../../../server/constants/activities';
import { sanitizeActivityData } from '../../../../server/graphql/common/activities';
import { allowContextPermission, PERMISSION_TYPE } from '../../../../server/graphql/common/context-permissions';
import models from '../../../../server/models';
import { fakeExpense, fakePayoutMethod, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/graphql/common/activities', () => {
  describe('sanitizeActivityData - COLLECTIVE_EXPENSE_UPDATED payout snapshots', () => {
    beforeEach(resetTestDB);

    it('authorizes previous and new payout-method snapshots independently', async () => {
      const payeeUser = await fakeUser();
      const oldPayoutMethod = await fakePayoutMethod({ CollectiveId: payeeUser.CollectiveId, isSaved: true });
      const newPayoutMethod = await fakePayoutMethod({ CollectiveId: payeeUser.CollectiveId, isSaved: true });
      const expense = await fakeExpense({
        PayoutMethodId: oldPayoutMethod.id,
        status: 'PENDING',
        FromCollectiveId: payeeUser.CollectiveId,
      });

      // Viewer with no role on the expense, granted access to the old method only
      const viewer = await fakeUser();
      const req = {
        remoteUser: viewer,
        loaders: {
          Expense: { byId: { load: async () => expense } },
          PayoutMethod: { byId: { load: async (id: number) => models.PayoutMethod.findByPk(id) } },
          Collective: { byId: { load: async (id: number) => models.Collective.findByPk(id) } },
        },
      } as unknown as Express.Request;
      allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, oldPayoutMethod.id);

      const activity = {
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        ExpenseId: expense.id,
        data: {
          previousData: { payoutMethod: { id: oldPayoutMethod.id, type: 'PAYPAL', name: 'Old' } },
          newData: { payoutMethod: { id: newPayoutMethod.id, type: 'PAYPAL', name: 'New' } },
        },
      };

      const sanitized = await sanitizeActivityData(req, activity);
      expect(sanitized.previousData?.['payoutMethod']).to.deep.equal({
        id: oldPayoutMethod.id,
        type: 'PAYPAL',
        name: 'Old',
      });
      expect(sanitized).to.not.have.nested.property('newData.payoutMethod');
    });
  });
});
