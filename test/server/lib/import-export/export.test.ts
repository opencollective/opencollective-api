import { expect } from 'chai';

import { buildForeignKeyTree, traverse } from '../../../../server/lib/import-export/export';
import models from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
  multiple,
  randEmail,
  randStr,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('export', () => {
  describe('buildForeignKeyTree', () => {
    it('should build a tree of foreign keys for all models', () => {
      const tree = buildForeignKeyTree(models);

      expect(tree.Collective).to.deep.include({ User: ['CollectiveId'] });
    });
  });

  describe('traverse', () => {
    let user;
    before(async () => {
      await resetTestDB();
      await multiple(fakeUser, 3);
      await multiple(fakeCollective, 3);
      user = await fakeUser({ collectiveData: { slug: 'test-user' } });
    });

    after(resetTestDB);

    it('should traverse using "on" statement', async () => {
      const parsed = {};
      const results = [];
      await traverse(
        {
          model: 'Collective',
          where: { slug: user.collective.slug },
          dependencies: [{ model: 'User', on: 'CollectiveId' }],
          parsed,
        },
        makeRequest(user),
        async ei => {
          results.push(ei);
        },
      );

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    it('should traverse using "from" statement', async () => {
      const parsed = {};
      const results = [];
      await traverse(
        {
          model: 'User',
          where: { id: user.id },
          dependencies: [{ model: 'Collective', from: 'CollectiveId' }],
          parsed,
        },
        makeRequest(user),
        async ei => {
          results.push(ei);
        },
      );

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    it('should traverse using where function parameter', async () => {
      const parsed = {};
      const results = [];
      await traverse(
        {
          model: 'User',
          where: { id: user.id },
          dependencies: [{ model: 'Collective', where: userRow => ({ id: userRow.CollectiveId }) }],
          parsed,
        },
        makeRequest(user),
        async ei => {
          results.push(ei);
        },
      );

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    describe('should prevent access to unauthorized data', () => {
      describe('host admin', () => {
        it('does not have access to random payout method details...', async () => {
          const payoutMethod = await fakePayoutMethod({
            type: PayoutMethodTypes.PAYPAL,
            name: randStr(),
            data: { email: randEmail() },
          });
          const expense = await fakeExpense({ PayoutMethodId: payoutMethod.id });
          const hostAdmin = await fakeUser();
          await hostAdmin.populateRoles();
          await expense.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
          const results = [];
          await traverse(
            {
              model: 'PayoutMethod',
              where: { id: expense.PayoutMethodId },
            },
            makeRequest(hostAdmin),
            async ei => results.push(ei),
          );

          expect(results).to.have.length(1);
          expect(results[0].id).to.eq(payoutMethod.id);
          expect(results[0].data).to.be.empty;
          expect(results[0].name).to.be.null;
          expect(results[0].isSaved).to.be.false;
        });

        it('...except if in context of a hosted expense', async () => {
          const payoutMethod = await fakePayoutMethod({
            type: PayoutMethodTypes.PAYPAL,
            name: randStr(),
            data: { email: randEmail() },
          });
          const expense = await fakeExpense({ PayoutMethodId: payoutMethod.id, privateMessage: 'ABC' });
          const hostAdmin = await fakeUser();
          await expense.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
          await hostAdmin.populateRoles();
          const results = [];
          await traverse(
            {
              model: 'Expense',
              where: { id: expense.id },
              dependencies: [{ model: 'PayoutMethod', where: expenseRow => ({ id: expenseRow.PayoutMethodId }) }],
            },
            makeRequest(hostAdmin),
            async ei => results.push(ei),
          );

          expect(results).to.have.length(2);
          const [resultExpense, resultPayoutMethod] = results;
          expect(resultPayoutMethod.id).to.eq(payoutMethod.id);
          expect(resultPayoutMethod.data).to.not.be.null;
          expect(resultPayoutMethod.name).to.not.be.null;
          expect(resultExpense.privateMessage).to.eq('ABC');
        });
      });
    });
  });
});
