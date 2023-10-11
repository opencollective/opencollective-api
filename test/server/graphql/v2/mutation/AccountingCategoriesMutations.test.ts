import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { get } from 'lodash';

import ActivityTypes from '../../../../../server/constants/activities';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeExpense,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2 } from '../../../../utils';

const fakeValidCategoryInput = (attrs = {}) => ({
  code: randStr(),
  name: randStr(),
  friendlyName: randStr(),
  ...attrs,
});

describe('server/graphql/v2/mutation/AccountingCategoriesMutations', () => {
  describe('editAccountingCategories', () => {
    const editAccountingCategoriesMutation = gqlV2/* GraphQL */ `
      mutation EditAccountingCategories($account: AccountReferenceInput!, $categories: [AccountingCategoryInput!]!) {
        editAccountingCategories(account: $account, categories: $categories) {
          ... on Organization {
            host {
              id
              accountingCategories {
                totalCount
                nodes {
                  id
                  code
                  name
                  friendlyName
                }
              }
            }
          }
        }
      }
    `;

    it('fails if user is not authenticated', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const result = await graphqlQueryV2(editAccountingCategoriesMutation, {
        account: { legacyId: host.id },
        categories: [fakeValidCategoryInput()],
      });

      expect(result.errors[0].message).to.equal(
        'You must be logged in as an admin of this account to edit its accounting categories',
      );
    });

    it('fails if the token does not have the right scope', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const userToken = await fakeUserToken({ scope: ['account'], UserId: admin.id });
      const result = await oAuthGraphqlQueryV2(
        editAccountingCategoriesMutation,
        { account: { legacyId: host.id }, categories: [fakeValidCategoryInput()] },
        userToken,
      );

      expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "host".');
    });

    it('fails if user is not authorized to edit accounting categories', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        { account: { legacyId: host.id }, categories: [fakeValidCategoryInput()] },
        randomUser,
      );

      expect(result.errors[0].message).to.equal(
        'You must be logged in as an admin of this account to edit its accounting categories',
      );
    });

    it('fails if categories contains an invalid id', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [fakeValidCategoryInput(), fakeValidCategoryInput({ id: 'invalid-id' })],
        },
        admin,
      );

      expect(result.errors[0].message).to.equal('Invalid accounting-category id: invalid-id');
    });

    it("fails if trying to edit/remove something that doesn't exist", async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [
            fakeValidCategoryInput(),
            fakeValidCategoryInput({ id: idEncode(9999999, 'accounting-category') }),
          ],
        },
        admin,
      );

      expect(result.errors[0].message).to.equal(
        "One of the entity you're trying to update doesn't exist or has changes. Please refresh the page.",
      );
    });

    it('fails if trying to edit something on another account', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const anotherCategory = await fakeAccountingCategory();
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [
            fakeValidCategoryInput(),
            fakeValidCategoryInput({ id: idEncode(anotherCategory.id, 'accounting-category') }),
          ],
        },
        admin,
      );

      expect(result.errors[0].message).to.equal(
        "One of the entity you're trying to update doesn't exist or has changes. Please refresh the page.",
      );
    });

    it('fails if trying to create a duplicate code', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const existingCategory = await fakeAccountingCategory({ CollectiveId: host.id });
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [
            { id: idEncode(existingCategory.id, 'accounting-category') },
            fakeValidCategoryInput({ code: existingCategory.code }),
          ],
        },
        admin,
      );

      expect(result.errors[0].message).to.equal('A category with this code already exists');
    });

    it('fails if trying to remove a category that has expenses attached', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const category = await fakeAccountingCategory({ CollectiveId: host.id });
      await fakeExpense({ CollectiveId: host.id, AccountingCategoryId: category.id, status: 'PAID' });
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        { account: { legacyId: host.id }, categories: [] },
        admin,
      );

      expect(result.errors[0].message).to.equal(
        'Cannot remove accounting categories that have already been used in paid expenses. Please re-categorize the expenses first.',
      );
    });

    it('edits accounting categories successfully', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const getNodesFromResult = result => get(result, 'data.editAccountingCategories.host.accountingCategories.nodes');

      // Host starts with no accounting categories
      expect(await host.getAccountingCategories()).to.have.length(0);

      // Create 2 items
      const initialCategoriesInput = [
        fakeValidCategoryInput({ code: '001', name: 'Initial name' }),
        fakeValidCategoryInput({ code: '002' }),
      ];
      const result1 = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        { account: { legacyId: host.id }, categories: initialCategoriesInput },
        admin,
      );

      expect(result1.errors).to.not.exist;
      expect(getNodesFromResult(result1)).to.have.length(2);
      expect(getNodesFromResult(result1)).to.containSubset(initialCategoriesInput);

      // Add + Remove + edit
      const result2 = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [
            fakeValidCategoryInput({ code: '003' }),
            fakeValidCategoryInput({
              id: getNodesFromResult(result1)[0].id,
              code: '001',
              name: 'EDITED',
            }),
          ],
        },
        admin,
      );

      expect(result2.errors).to.not.exist;
      expect(result2.data.editAccountingCategories.host.accountingCategories.nodes).to.have.length(2);
      expect(result2.data.editAccountingCategories.host.accountingCategories.nodes).to.containSubset([
        { code: '003' },
        { id: getNodesFromResult(result1)[0].id, code: '001', name: 'EDITED' },
      ]);

      // Empty everything
      const result3 = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        { account: { legacyId: host.id }, categories: [] },
        admin,
      );

      expect(result3.errors).to.not.exist;
      expect(result3.data.editAccountingCategories.host.accountingCategories.nodes).to.have.length(0);

      // Check activities
      const activities = await models.Activity.findAll({
        where: { CollectiveId: host.id, type: ActivityTypes.ACCOUNTING_CATEGORIES_EDITED },
        order: [['createdAt', 'ASC']],
      });

      expect(activities).to.have.length(3);
      activities.forEach(activity => {
        expect(activity.HostCollectiveId).to.equal(host.id);
        expect(activity.CollectiveId).to.equal(host.id);
        expect(activity.UserId).to.equal(admin.id);
      });

      expect(activities[0].data.added).to.have.length(2);
      expect(activities[0].data.removed).to.have.length(0);
      expect(activities[0].data.edited).to.have.length(0);
      expect(activities[0].data).to.containSubset({ added: initialCategoriesInput });

      expect(activities[1].data.added).to.have.length(1);
      expect(activities[1].data.removed).to.have.length(1);
      expect(activities[1].data.edited).to.have.length(1);
      expect(activities[1].data).to.containSubset({
        added: [{ code: '003' }],
        removed: [{ code: '002' }],
        edited: [{ previousData: { code: '001', name: 'Initial name' }, newData: { code: '001', name: 'EDITED' } }],
      });

      expect(activities[2].data.added).to.have.length(0);
      expect(activities[2].data.removed).to.have.length(2);
      expect(activities[2].data.edited).to.have.length(0);
      expect(activities[2].data).to.containSubset({ removed: [{ code: '003' }] });
    });
  });
});
