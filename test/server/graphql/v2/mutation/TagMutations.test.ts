import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeCollective, fakeExpense, fakeHost, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2 } from '../../../../utils.js';

const SET_TAGS_MUTATION = gqlV2/* GraphQL */ `
  mutation SetTags($expense: ExpenseReferenceInput, $order: OrderReferenceInput, $tags: [String!]!) {
    setTags(expense: $expense, order: $order, tags: $tags) {
      expense {
        id
        tags
      }
      order {
        id
        tags
      }
    }
  }
`;

describe('server/graphql/v2/mutation/TagsMutation', () => {
  let adminUser;
  let hostAdminUser;
  let collective;

  before(async () => {
    adminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    const host = await fakeHost({ admin: hostAdminUser });
    collective = await fakeCollective({ admin: adminUser, HostCollectiveId: host.id });
  });

  describe('Set tags on Expense', () => {
    let expense;

    before(async () => {
      expense = await fakeExpense({ CollectiveId: collective.id });
    });

    it('fails if not logged in', async () => {
      const result = await graphqlQueryV2(SET_TAGS_MUTATION, {
        expense: { legacyId: expense.id },
        tags: ['tag1', 'tag2'],
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage expenses');
    });

    it('fails if not logged in as admin of collective', async () => {
      // Random user
      const result = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { expense: { legacyId: expense.id }, tags: ['tag1', 'tag2'] },
        await fakeUser(),
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have the permissions to set tags on this expense');
    });

    it('works if allowed', async () => {
      // Collective admin
      const result = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { expense: { legacyId: expense.id }, tags: ['tag1', 'tag2'] },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.setTags.expense.tags).to.deep.equal(['tag1', 'tag2']);

      // Host admin
      const result2 = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { expense: { legacyId: expense.id }, tags: ['tag3', 'tag4'] },
        hostAdminUser,
      );

      expect(result2.errors).to.not.exist;
      expect(result2.data.setTags.expense.tags).to.deep.equal(['tag3', 'tag4']);

      // Expense creator
      const result3 = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { expense: { legacyId: expense.id }, tags: ['tag5', 'tag3'] },
        expense.User,
      );

      expect(result3.errors).to.not.exist;
      expect(result3.data.setTags.expense.tags).to.deep.equal(['tag5', 'tag3']);
    });
  });

  describe('Set tags on Order', () => {
    let order;

    before(async () => {
      order = await fakeOrder({ CollectiveId: collective.id });
    });

    it('fails if not logged in', async () => {
      const result = await graphqlQueryV2(SET_TAGS_MUTATION, {
        order: { legacyId: order.id },
        tags: ['tag1', 'tag2'],
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage orders');
    });

    it('fails if not logged in as admin of collective', async () => {
      // Random user
      const result = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { order: { legacyId: order.id }, tags: ['tag1', 'tag2'] },
        await fakeUser(),
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have the permissions to set tags on this order');

      // Order creator
      const result2 = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { order: { legacyId: order.id }, tags: ['tag1', 'tag2'] },
        order.createdByUser,
      );

      expect(result2.errors).to.exist;
      expect(result2.errors[0].message).to.equal('You do not have the permissions to set tags on this order');
    });

    it('works if allowed', async () => {
      // Collective admin
      const result = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { order: { legacyId: order.id }, tags: ['tag1', 'tag2'] },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.setTags.order.tags).to.deep.equal(['tag1', 'tag2']);

      // Host admin
      const result2 = await graphqlQueryV2(
        SET_TAGS_MUTATION,
        { order: { legacyId: order.id }, tags: ['tag3', 'tag4'] },
        hostAdminUser,
      );

      expect(result2.errors).to.not.exist;
      expect(result2.data.setTags.order.tags).to.deep.equal(['tag3', 'tag4']);
    });
  });
});
