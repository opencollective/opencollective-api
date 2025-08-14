import { expect } from 'chai';
import gql from 'fake-tag';
import { omit } from 'lodash';

import { roles } from '../../../../../server/constants';
import { PlatformSubscriptionTiers } from '../../../../../server/constants/plans';
import { fakeCollective, fakeMember, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/PlatformSubscriptionsMutations', () => {
  describe('updateAccountPlatformSubscription', () => {
    const updateAccountPlatformSubscriptionMutation = gql`
      mutation Update($account: AccountReferenceInput!, $subscription: PlatformSubscriptionInput, $planId: String) {
        updateAccountPlatformSubscription(account: $account, subscription: $subscription, planId: $planId) {
          id

          ... on AccountWithPlatformSubscription {
            platformSubscription {
              plan {
                title
                type
                pricing {
                  pricePerMonth {
                    valueInCents
                    currency
                  }
                  pricePerAdditionalCollective {
                    valueInCents
                    currency
                  }
                  pricePerAdditionalExpense {
                    valueInCents
                    currency
                  }
                  includedCollectives
                  includedExpensesPerMonth
                }
              }
            }
          }
        }
      }
    `;

    it('must be root to set custom plan', async () => {
      const root = await fakeUser({ data: { isRoot: true } }, null);
      await fakeMember({
        CollectiveId: 1,
        MemberCollectiveId: root.CollectiveId,
        role: roles.ADMIN,
      });

      const colUser = await fakeUser();
      const col = await fakeCollective({
        admin: colUser,
      });

      const plan = {
        title: 'Custom title',
        type: 'Basic',
        basePlanId: 'basic-5',
        pricing: {
          pricePerMonth: { valueInCents: 1200, currency: 'USD' },
          pricePerAdditionalCollective: { valueInCents: 100, currency: 'USD' },
          pricePerAdditionalExpense: { valueInCents: 2500, currency: 'USD' },
          includedCollectives: 22,
          includedExpensesPerMonth: 11,
        },
        features: PlatformSubscriptionTiers.find(plan => plan.id === 'basic-5').features,
      };

      let res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          subscription: {
            plan,
          },
        },
        colUser,
      );

      expect(res.errors).to.not.be.empty;
      expect(res.errors[0].message).to.eql('Only root users can set custom platform plans');

      res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          subscription: {
            plan,
          },
        },
        root,
      );

      expect(res.errors).to.be.undefined;
      expect(res.data.updateAccountPlatformSubscription.platformSubscription).to.containSubset({
        plan: omit(plan, ['features', 'basePlanId']),
      });
    });

    it('must be account admin to change plan', async () => {
      const unrelatedUser = await fakeUser();
      const colUser = await fakeUser();
      const col = await fakeCollective({
        admin: colUser,
      });

      const res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'basic-5',
        },
        unrelatedUser,
      );

      expect(res.errors).to.not.be.empty;
      expect(res.errors[0].message).to.eql('User cannot update subscription');
    });

    it('must be valid plan id', async () => {
      const colUser = await fakeUser();
      const col = await fakeCollective({
        admin: colUser,
      });

      const res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'not-a-plan',
        },
        colUser,
      );

      expect(res.errors).to.not.be.empty;
      expect(res.errors[0].message).to.eql('Invalid plan ID');
    });

    it('updates plan with plan id', async () => {
      const colUser = await fakeUser();
      const col = await fakeCollective({
        admin: colUser,
      });

      const res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'basic-5',
        },
        colUser,
      );

      expect(res.errors).to.be.undefined;
      expect(res.data.updateAccountPlatformSubscription.platformSubscription).to.containSubset({
        plan: {
          title: 'Basic 5',
          type: 'Basic',
          pricing: {
            pricePerMonth: { valueInCents: 5000, currency: 'USD' },
            pricePerAdditionalCollective: { valueInCents: 1500, currency: 'USD' },
            pricePerAdditionalExpense: { valueInCents: 150, currency: 'USD' },
            includedCollectives: 5,
            includedExpensesPerMonth: 50,
          },
        },
      });
    });
  });
});
