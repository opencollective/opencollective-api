import { expect } from 'chai';
import * as cheerio from 'cheerio';
import gql from 'fake-tag';
import { omit } from 'lodash';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { PlatformSubscriptionTiers } from '../../../../../server/constants/plans';
import emailLib from '../../../../../server/lib/email';
import { PlatformSubscription } from '../../../../../server/models';
import {
  fakeCollective,
  fakeHost,
  fakeMember,
  fakePersonalToken,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import {
  getOrCreatePlatformAccount,
  graphqlQueryV2,
  oAuthGraphqlQueryV2,
  personalTokenGraphqlQueryV2,
  waitForCondition,
} from '../../../../utils';

describe('server/graphql/v2/mutation/PlatformSubscriptionsMutations', () => {
  describe('updateAccountPlatformSubscription', () => {
    let sandbox, sendEmailSpy, platform;

    before(async () => {
      platform = await getOrCreatePlatformAccount();
    });

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

    const customPlan = {
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

    describe('custom plan root scope', () => {
      let root, host;

      beforeEach(async () => {
        root = await fakeUser({ data: { isRoot: true } }, null);
        await fakeMember({ CollectiveId: platform.id, MemberCollectiveId: root.CollectiveId, role: roles.ADMIN });
        host = await fakeHost({ admin: await fakeUser() });
        await root.populateRoles();
        expect(root.isRoot()).to.be.true;
        expect(root.isAdminOfCollective(host)).to.be.false;
        expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.be.null;
      });

      for (const auth of ['OAuth', 'personal token']) {
        it(`rejects an account-scoped ${auth} without creating a subscription`, async () => {
          const variables = { account: { legacyId: host.id }, subscription: { plan: customPlan } };
          const result =
            auth === 'OAuth'
              ? await oAuthGraphqlQueryV2(
                  updateAccountPlatformSubscriptionMutation,
                  variables,
                  await fakeUserToken({ user: root, scope: ['account'] }),
                )
              : await personalTokenGraphqlQueryV2(
                  updateAccountPlatformSubscriptionMutation,
                  variables,
                  await fakePersonalToken({ user: root, scope: [OAuthScopes.account] }),
                );

          expect(result.errors).to.not.be.empty;
          expect(result.errors[0].extensions.code).to.equal('Forbidden');
          expect(result.errors[0].message).to.equal(
            `The ${auth === 'OAuth' ? 'User' : 'Personal'} Token is not allowed for operations in scope "root".`,
          );
          expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.be.null;
          expect(await PlatformSubscription.count({ where: { CollectiveId: host.id } })).to.equal(0);
        });
      }

      it('checks root scope before reading the custom plan input', async () => {
        const token = await fakeUserToken({ user: root, scope: ['account'] });
        const result = await oAuthGraphqlQueryV2(
          updateAccountPlatformSubscriptionMutation,
          { account: { legacyId: host.id } },
          token,
        );

        expect(result.errors).to.not.be.empty;
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
        expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "root".');
        expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.be.null;
      });

      for (const auth of ['session', 'OAuth']) {
        it(`allows custom plans through ${auth} with root authority`, async () => {
          const variables = { account: { legacyId: host.id }, subscription: { plan: customPlan } };
          const result =
            auth === 'session'
              ? await graphqlQueryV2(updateAccountPlatformSubscriptionMutation, variables, root)
              : await oAuthGraphqlQueryV2(
                  updateAccountPlatformSubscriptionMutation,
                  variables,
                  await fakeUserToken({ user: root, scope: ['account', 'root'] }),
                );

          expect(result.errors).to.be.undefined;
          expect(result.data.updateAccountPlatformSubscription.platformSubscription).to.containSubset({
            plan: omit(customPlan, ['features', 'basePlanId']),
          });
          expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.exist;
        });
      }

      for (const auth of ['OAuth', 'personal token']) {
        it(`rejects an account-scoped ${auth} selecting a plan for an unrelated account`, async () => {
          const variables = { account: { legacyId: host.id }, planId: 'basic-5' };
          const result =
            auth === 'OAuth'
              ? await oAuthGraphqlQueryV2(
                  updateAccountPlatformSubscriptionMutation,
                  variables,
                  await fakeUserToken({ user: root, scope: ['account'] }),
                )
              : await personalTokenGraphqlQueryV2(
                  updateAccountPlatformSubscriptionMutation,
                  variables,
                  await fakePersonalToken({ user: root, scope: [OAuthScopes.account] }),
                );

          expect(result.errors).to.not.be.empty;
          expect(result.errors[0].extensions.code).to.equal('Forbidden');
          expect(result.errors[0].message).to.equal(
            `The ${auth === 'OAuth' ? 'User' : 'Personal'} Token is not allowed for operations in scope "root".`,
          );
          expect(await PlatformSubscription.count({ where: { CollectiveId: host.id } })).to.equal(0);
        });
      }

      it('allows a root-scoped token to select a plan for an unrelated account', async () => {
        const result = await oAuthGraphqlQueryV2(
          updateAccountPlatformSubscriptionMutation,
          { account: { legacyId: host.id }, planId: 'basic-5' },
          await fakeUserToken({ user: root, scope: ['account', 'root'] }),
        );

        expect(result.errors).to.be.undefined;
        expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.exist;
      });

      it('allows an account admin to select a plan with only account scope', async () => {
        await fakeMember({ CollectiveId: host.id, MemberCollectiveId: root.CollectiveId, role: roles.ADMIN });
        const result = await oAuthGraphqlQueryV2(
          updateAccountPlatformSubscriptionMutation,
          { account: { legacyId: host.id }, planId: 'basic-5' },
          await fakeUserToken({ user: root, scope: ['account'] }),
        );

        expect(result.errors).to.be.undefined;
        expect(await PlatformSubscription.getCurrentSubscription(host.id)).to.exist;
      });
    });

    it('must be root to set custom plan', async () => {
      const root = await fakeUser({ data: { isRoot: true } }, null);
      await fakeMember({
        CollectiveId: platform.id,
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

    it('requires 2FA when an admin with 2FA configured changes the plan', async () => {
      const adminUser = await fakeUser({}, {}, { enable2FA: true });
      const col = await fakeCollective({
        admin: adminUser,
        data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
      });

      const res = await graphqlQueryV2(
        updateAccountPlatformSubscriptionMutation,
        {
          account: { slug: col.slug },
          planId: 'basic-5',
        },
        adminUser,
      );

      expect(res.errors).to.not.be.empty;
      expect(res.errors[0].message).to.eql('Two-factor authentication required');
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
            pricePerMonth: { valueInCents: 6000, currency: 'USD' },
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
      expect(newPlanPrice).to.contain('$60.00 / Month');

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
