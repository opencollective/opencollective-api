import { expect } from 'chai';
import gql from 'fake-tag';
import { get } from 'lodash';

import ActivityTypes from '../../../../../server/constants/activities';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import { FEATURE } from '../../../../../server/lib/allowed-features';
import models from '../../../../../server/models';
import { ContributionAccountingCategoryRule } from '../../../../../server/models/ContributionAccountingCategoryRule';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeExpense,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, sleep } from '../../../../utils';

const fakeValidCategoryInput = (attrs = {}) => ({
  code: randStr(),
  name: randStr(),
  friendlyName: randStr(),
  ...attrs,
});

describe('server/graphql/v2/mutation/AccountingCategoriesMutations', () => {
  describe('editAccountingCategories', () => {
    const editAccountingCategoriesMutation = gql`
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
                  expensesTypes
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
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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

    it('fails if the expenses types are not valid', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
      const result = await graphqlQueryV2(
        editAccountingCategoriesMutation,
        {
          account: { legacyId: host.id },
          categories: [fakeValidCategoryInput({ expensesTypes: ['INVALID'] })],
        },
        admin,
      );

      expect(result.errors[0].message).to.include('Value "INVALID" does not exist in "ExpenseType" enum.');
    });

    it('edits accounting categories successfully', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ plan: 'start-plan-2021', admin });
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
              expensesTypes: ['INVOICE', 'INVOICE'], // To make sure the value will be deduplicated
            }),
          ],
        },
        admin,
      );

      result2.errors && console.error(result2.errors);
      expect(result2.errors).to.not.exist;
      expect(getNodesFromResult(result2)).to.have.length(2);
      expect(getNodesFromResult(result2)).to.containSubset([
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
      expect(getNodesFromResult(result3)).to.have.length(0);

      // Check activities
      const activities = await models.Activity.findAll({
        where: { CollectiveId: host.id, type: ActivityTypes.ACCOUNTING_CATEGORIES_EDITED },
        order: [['createdAt', 'ASC']],
      });

      await sleep(100); // For the async activity creation
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
        edited: [
          {
            previousData: { code: '001', name: 'Initial name' },
            newData: { code: '001', name: 'EDITED', expensesTypes: ['INVOICE'] },
          },
        ],
      });

      expect(activities[2].data.added).to.have.length(0);
      expect(activities[2].data.removed).to.have.length(2);
      expect(activities[2].data.edited).to.have.length(0);
      expect(activities[2].data).to.containSubset({ removed: [{ code: '003' }] });
    });
  });

  describe('updateContributionAccountingCategoryRules', () => {
    const updateContributionAccountingCategoryRulesMutation = gql`
      mutation UpdateContributionAccountingCategoryRules(
        $account: AccountReferenceInput!
        $rules: [ContributionAccountingCategoryRuleInput!]!
      ) {
        updateContributionAccountingCategoryRules(account: $account, rules: $rules) {
          id
        }
      }
    `;

    it('fails if user is not authenticated', async () => {
      const host = await fakeActiveHost();
      const result = await graphqlQueryV2(updateContributionAccountingCategoryRulesMutation, {
        account: { legacyId: host.id },
        rules: [],
      });

      expect(result.errors[0].message).to.equal(
        'You must be logged in as an admin of this account to update its contribution accounting category rules',
      );
    });

    it('fails if the token does not have the right scope', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const userToken = await fakeUserToken({ scope: ['account'], UserId: admin.id });
      const result = await oAuthGraphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        { account: { legacyId: host.id }, rules: [] },
        userToken,
      );

      expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "host".');
    });

    it('fails if user is not authorized to update contribution accounting category rules', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        { account: { legacyId: host.id }, rules: [] },
        randomUser,
      );

      expect(result.errors[0].message).to.equal(
        'You must be logged in as an admin of this account to update its contribution accounting category rules',
      );
    });

    it('fails if contribution accounting category rules are not set at the host level', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        hasMoneyManagement: false,
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const result = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        { account: { legacyId: host.id }, rules: [] },
        admin,
      );

      expect(result.errors[0].message).to.equal(
        'Contribution accounting category rules can only be set at the host level',
      );
    });

    it('updates contribution accounting category rules successfully', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });

      const initialRulesInput = [
        {
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
          name: 'Rule A',
          enabled: true,
          predicates: [
            {
              subject: 'description',
              operator: 'contains',
              value: 'foo',
            },
          ],
        },
        {
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
          name: 'Rule B',
          enabled: true,
          predicates: [
            {
              subject: 'amount',
              operator: 'gte',
              value: 1000,
            },
          ],
        },
      ];

      const result1 = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        { account: { legacyId: host.id }, rules: initialRulesInput },
        admin,
      );

      expect(result1.errors).to.not.exist;

      const createdRules = await ContributionAccountingCategoryRule.findAll({
        where: { CollectiveId: host.id },
        order: [['order', 'ASC']],
      });
      expect(createdRules).to.have.length(2);
      expect(createdRules[0].name).to.equal('Rule A');
      expect(createdRules[1].name).to.equal('Rule B');
      expect(createdRules[0].order).to.equal(0);
      expect(createdRules[1].order).to.equal(1);
      expect(createdRules[0].AccountingCategoryId).to.equal(accountingCategory.id);
      expect(createdRules[1].AccountingCategoryId).to.equal(accountingCategory.id);

      // Update + Add (and implicitly remove the second initial rule)
      const result2 = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        {
          account: { legacyId: host.id },
          rules: [
            {
              id: idEncode(createdRules[0].id, 'contribution-accounting-category-rule'),
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
              name: 'Rule A - edited',
              enabled: false,
              predicates: [
                {
                  subject: 'description',
                  operator: 'contains',
                  value: 'bar',
                },
              ],
            },
            {
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
              name: 'Rule C',
              enabled: true,
              predicates: [
                {
                  subject: 'currency',
                  operator: 'eq',
                  value: 'USD',
                },
              ],
            },
          ],
        },
        admin,
      );

      expect(result2.errors).to.not.exist;

      const updatedRules = await ContributionAccountingCategoryRule.findAll({
        where: { CollectiveId: host.id },
        order: [['order', 'ASC']],
      });
      expect(updatedRules).to.have.length(2);

      const updatedRuleA = updatedRules.find(r => r.id === createdRules[0].id);
      const ruleC = updatedRules.find(r => r.name === 'Rule C');

      expect(updatedRuleA).to.exist;
      expect(updatedRuleA.enabled).to.be.false;
      expect(updatedRuleA.name).to.equal('Rule A - edited');
      expect(updatedRuleA.order).to.equal(0);

      expect(ruleC).to.exist;
      expect(ruleC.enabled).to.be.true;
      expect(ruleC.order).to.equal(1);

      // The original "Rule B" should have been deleted
      expect(updatedRules.find(r => r.id === createdRules[1].id)).to.not.exist;
    });

    it('fails if predicate "toAccount" references an unknown account', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });

      const result = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        {
          account: { legacyId: host.id },
          rules: [
            {
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
              name: 'Invalid toAccount rule',
              enabled: true,
              predicates: [
                {
                  subject: 'toAccount',
                  operator: 'eq',
                  // Encodes a non-existing account id
                  value: idEncode(9999999, 'account'),
                },
              ],
            },
          ],
        },
        admin,
      );

      expect(result.errors[0].message).to.include('Invalid value');
    });

    it('fails if predicate expecting an array receives a string', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
        admin,
      });
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });

      const result = await graphqlQueryV2(
        updateContributionAccountingCategoryRulesMutation,
        {
          account: { legacyId: host.id },
          rules: [
            {
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
              name: 'Invalid frequency rule',
              enabled: true,
              predicates: [
                {
                  subject: 'frequency',
                  operator: 'in',
                  // Should be an array of intervals, but is a single string
                  value: 'month',
                },
              ],
            },
          ],
        },
        admin,
      );

      expect(result.errors[0].message).to.include('Invalid value');
    });
  });
});
