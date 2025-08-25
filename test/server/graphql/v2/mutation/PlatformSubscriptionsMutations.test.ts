import { expect } from 'chai';
import * as cheerio from 'cheerio';
import gql from 'fake-tag';
import { omit } from 'lodash';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import { PlatformSubscriptionTiers } from '../../../../../server/constants/plans';
import emailLib from '../../../../../server/lib/email';
import { fakeCollective, fakeMember, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, waitForCondition } from '../../../../utils';

describe('server/graphql/v2/mutation/PlatformSubscriptionsMutations', () => {
  describe('updateAccountPlatformSubscription', () => {
    let sandbox, sendEmailSpy;

    beforeEach(() => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    afterEach(() => {
      sandbox.restore();
    });

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

    it('sends platform subscription updated email when subscription is updated', async () => {
      const colUser = await fakeUser();
      const col = await fakeCollective({
        admin: colUser,
      });

      // First, set up an initial subscription
      await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'discover-1',
        },
        colUser,
      );

      // Wait for any initial email to be sent and clear the spy
      const getEmailForAdmin = calls => calls.find(([to]) => to === colUser.email);
      await waitForCondition(() => sendEmailSpy.callCount > 0 && getEmailForAdmin(sendEmailSpy.args));

      const firstEmail = getEmailForAdmin(sendEmailSpy.args);
      expect(firstEmail[2]).to.not.contain('previous-plan');
      expect(firstEmail[2]).to.contain('new-plan');

      sendEmailSpy.resetHistory();

      // Update to a new subscription
      const res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'basic-5',
        },
        colUser,
      );

      expect(res.errors).to.be.undefined;

      // Wait for the email to be sent
      await waitForCondition(() => sendEmailSpy.callCount > 0 && getEmailForAdmin(sendEmailSpy.args));

      // Check that the platform subscription updated email was sent
      const [recipient, subject, html, options] = getEmailForAdmin(sendEmailSpy.args);

      expect(options.tag).to.equal('platform.subscription.updated');
      expect(recipient).to.equal(colUser.email);
      expect(subject).to.contain(`Platform subscription updated for ${col.name}`);

      // Parse email HTML with cheerio
      const $ = cheerio.load(html);
      const allText = $('body').text();

      // General assertions
      expect(allText).to.contain(`The platform subscription for ${col.name} has been updated`);

      // Check previous plan
      const previousPlanSection = $('.previous-plan');
      expect(previousPlanSection).to.have.length(1);
      const previousPlanCard = previousPlanSection.find('.plan-card');
      expect(previousPlanCard).to.have.length(1);

      const previousPlanLabel = previousPlanCard.find('.plan-label').text();
      expect(previousPlanLabel).to.contain('Previous Tier:');
      expect(previousPlanLabel).to.contain('Discover 1');

      const previousPlanPrice = previousPlanCard.find('.plan-price').text();
      expect(previousPlanPrice).to.equal('Free');

      const previousPlanFeatures = previousPlanCard.find('.plan-feature');
      expect(previousPlanFeatures).to.have.length.at.least(2);

      const previousCollectivesFeature = previousPlanFeatures.eq(0).text();
      expect(previousCollectivesFeature).to.contain('1 Active Collective');

      const previousExpensesFeature = previousPlanFeatures.eq(1).text();
      expect(previousExpensesFeature).to.contain('10 Paid expenses');

      // Check new plan details
      const newPlanSection = $('.new-plan');

      expect(newPlanSection).to.have.length(1);
      const newPlanCard = newPlanSection.find('.plan-card');
      expect(newPlanCard).to.have.length(1);

      const newPlanLabel = newPlanCard.find('.plan-label').text();
      expect(newPlanLabel).to.contain('New Tier:');
      expect(newPlanLabel).to.contain('Basic 5');

      const newPlanPrice = newPlanCard.find('.plan-price').text();
      expect(newPlanPrice).to.contain('$50.00 / Month');

      const newPlanFeatures = newPlanCard.find('.plan-feature');
      expect(newPlanFeatures).to.have.length.at.least(2);

      const newCollectivesFeature = newPlanFeatures.eq(0).text();
      expect(newCollectivesFeature).to.contain('5 Active Collectives');
      expect(newCollectivesFeature).to.contain('$15.00 / Collective after that');

      const newExpensesFeature = newPlanFeatures.eq(1).text();
      expect(newExpensesFeature).to.contain('50 Paid expenses');
      expect(newExpensesFeature).to.contain('$1.50 / expense after that');
    });
  });
});
