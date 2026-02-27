import { expect } from 'chai';

import { CollectiveType } from '../../../server/constants/collectives';
import FEATURE from '../../../server/constants/feature';
import { checkFeatureAccess, getFeatureAccess, getFeaturesAccessMap } from '../../../server/lib/allowed-features';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeHost,
  fakeOrganization,
  fakePlatformSubscription,
  fakeProject,
  fakeUser,
} from '../../test-helpers/fake-data';
import { getOrCreatePlatformAccount } from '../../utils';

describe('server/lib/allowed-features', () => {
  let platform;

  before(async () => {
    platform = await getOrCreatePlatformAccount();
  });

  // This test case is expected to be the most comprehensive one, covering all the feature flags
  describe('getFeatureAccess', () => {
    it('returns UNSUPPORTED if collective is null', async () => {
      expect(await getFeatureAccess(null, FEATURE.CONVERSATIONS)).to.deep.eq({ access: 'UNSUPPORTED', reason: null });
    });

    it('returns DISABLED if collective is suspended', async () => {
      const collective = await fakeCollective({ data: { isSuspended: true } });
      expect(await getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.deep.eq({
        access: 'DISABLED',
        reason: 'BLOCKED',
      });
    });

    it('returns DISABLED if feature is globally blocked', async () => {
      const collective = await fakeCollective({ data: { features: { ALL: false } } });
      expect(await getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.deep.eq({
        access: 'DISABLED',
        reason: 'BLOCKED',
      });
    });

    it('returns DISABLED if feature is specifically blocked', async () => {
      const collective = await fakeCollective({ data: { features: { [FEATURE.CONVERSATIONS]: false } } });
      expect(await getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.deep.eq({
        access: 'DISABLED',
        reason: 'BLOCKED',
      });
    });

    it('returns DISABLED + PRICING if feature is not available in current plan', async () => {
      const host = await fakeActiveHost({ data: { features: { [FEATURE.CHART_OF_ACCOUNTS]: true } } });
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { CHART_OF_ACCOUNTS: false } },
      });

      expect(await getFeatureAccess(host, FEATURE.CHART_OF_ACCOUNTS)).to.deep.eq({
        access: 'DISABLED',
        reason: 'PRICING',
      });
    });

    describe('ALIPAY', () => {
      it('is AVAILABLE for active hosts, UNSUPPORTED otherwise', async () => {
        const host = await fakeActiveHost();
        expect(await getFeatureAccess(host, FEATURE.ALIPAY)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const inactiveHost = await fakeCollective({ hasMoneyManagement: true, isActive: false });
        expect(await getFeatureAccess(inactiveHost, FEATURE.ALIPAY)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.ALIPAY)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('COLLECTIVE_GOALS', () => {
      it('is DISABLED for active collectives/orgs/projects by default (opt-in), AVAILABLE if opted in, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({ isActive: true });
        expect(await getFeatureAccess(collective, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const org = await fakeOrganization({ isActive: true });
        expect(await getFeatureAccess(org, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const project = await fakeProject({ isActive: true });
        expect(await getFeatureAccess(project, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const event = await fakeEvent({ isActive: true });
        expect(await getFeatureAccess(event, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const optedIn = await fakeCollective({
          isActive: true,
          data: { features: { [FEATURE.COLLECTIVE_GOALS]: true } },
        });
        expect(await getFeatureAccess(optedIn, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const flagOverride = await fakeCollective({
          isActive: true,
          settings: { collectivePage: { showGoals: true } },
        });
        expect(await getFeatureAccess(flagOverride, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const disabled = await fakeCollective({
          isActive: true,
          data: { features: { [FEATURE.COLLECTIVE_GOALS]: false } },
        });
        expect(await getFeatureAccess(disabled, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'BLOCKED',
        });
        const flagOverrideDisabled = await fakeCollective({
          isActive: true,
          settings: { collectivePage: { showGoals: false } },
        });
        expect(await getFeatureAccess(flagOverrideDisabled, FEATURE.COLLECTIVE_GOALS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'BLOCKED',
        });
      });
    });

    describe('CONTACT_FORM', () => {
      it('is AVAILABLE for active accounts of allowed types, DISABLED if opted out, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({
          isActive: true,
        });
        expect(await getFeatureAccess(collective, FEATURE.CONTACT_FORM)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const org = await fakeOrganization({ isActive: true });
        expect(await getFeatureAccess(org, FEATURE.CONTACT_FORM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const event = await fakeEvent({ isActive: true });
        expect(await getFeatureAccess(event, FEATURE.CONTACT_FORM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true });
        expect(await getFeatureAccess(fund, FEATURE.CONTACT_FORM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const project = await fakeProject({ isActive: true });
        expect(await getFeatureAccess(project, FEATURE.CONTACT_FORM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const user = await fakeUser({ isActive: true });
        expect(await getFeatureAccess(user.collective, FEATURE.CONTACT_FORM)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const inactive = await fakeCollective({
          isActive: false,
        });
        expect(await getFeatureAccess(inactive, FEATURE.CONTACT_FORM)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const disabled = await fakeCollective({
          isActive: true,

          data: { features: { [FEATURE.CONTACT_FORM]: false } },
        });
        expect(await getFeatureAccess(disabled, FEATURE.CONTACT_FORM)).to.deep.eq({
          access: 'DISABLED',
          reason: 'BLOCKED',
        });
        const flagOverride = await fakeCollective({
          isActive: true,
          settings: { features: { contactForm: false } },
        });
        expect(await getFeatureAccess(flagOverride, FEATURE.CONTACT_FORM)).to.deep.eq({
          access: 'DISABLED',
          reason: 'BLOCKED',
        });
      });
    });

    describe('CONVERSATIONS', () => {
      it('is AVAILABLE for collectives and organizations, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.CONVERSATIONS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.CONVERSATIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.CONVERSATIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('EVENTS', () => {
      it('is AVAILABLE for active collectives and organizations, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({ isActive: true });
        expect(await getFeatureAccess(collective, FEATURE.EVENTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const org = await fakeOrganization({ isActive: true });
        expect(await getFeatureAccess(org, FEATURE.EVENTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const inactive = await fakeCollective({ isActive: false });
        expect(await getFeatureAccess(inactive, FEATURE.EVENTS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const user = await fakeUser({ isActive: true });
        expect(await getFeatureAccess(user.collective, FEATURE.EVENTS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('HOST_DASHBOARD', () => {
      it('is AVAILABLE for hosts, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost();
        expect(await getFeatureAccess(host, FEATURE.HOST_DASHBOARD)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const independentCollective = await fakeCollective({ hasMoneyManagement: true, isActive: false });
        expect(await getFeatureAccess(independentCollective, FEATURE.HOST_DASHBOARD)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.HOST_DASHBOARD)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('KYC', () => {
      it('is AVAILABLE with plan for first party hosts, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({
          data: {
            isFirstPartyHost: true,
            features: { [FEATURE.KYC]: true },
          },
        });
        expect(await getFeatureAccess(host, FEATURE.KYC)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const independentCollective = await fakeCollective({ hasMoneyManagement: true, isActive: false });
        expect(await getFeatureAccess(independentCollective, FEATURE.KYC)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.KYC)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('PERSONA_KYC', () => {
      it('is AVAILABLE with plan for first party hosts, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({
          data: {
            isFirstPartyHost: true,
            features: { [FEATURE.PERSONA_KYC]: true },
          },
        });
        expect(await getFeatureAccess(host, FEATURE.PERSONA_KYC)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const independentCollective = await fakeCollective({ hasMoneyManagement: true, isActive: false });
        expect(await getFeatureAccess(independentCollective, FEATURE.PERSONA_KYC)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.PERSONA_KYC)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('OFF_PLATFORM_TRANSACTIONS', () => {
      describe('with the legacy pricing', () => {
        it('is AVAILABLE for platform orgs by default', async () => {
          expect(await getFeatureAccess(platform, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });

        it('is AVAILABLE for active hosts if opted in', async () => {
          const host = await fakeActiveHost({
            plan: 'start-plan-2021',
            data: { features: { [FEATURE.OFF_PLATFORM_TRANSACTIONS]: true } },
          });
          expect(await getFeatureAccess(host, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });

        it('is DISABLED if not opted in', async () => {
          const host = await fakeActiveHost({ plan: 'start-plan-2021' });
          expect(await getFeatureAccess(host, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'DISABLED',
            reason: 'OPT_IN',
          });
        });

        it('is UNSUPPORTED for inactive hosts', async () => {
          const host = await fakeHost({ isActive: false });
          expect(await getFeatureAccess(host, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'DISABLED',
            reason: 'PRICING',
          });
        });

        it('is supported for independent collectives', async () => {
          const collective = await fakeCollective({
            plan: 'start-plan-2021',
            hasMoneyManagement: true,
            isActive: true,
            data: { features: { [FEATURE.OFF_PLATFORM_TRANSACTIONS]: true } },
          });
          expect(await getFeatureAccess(collective, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });

        it('is UNSUPPORTED for users', async () => {
          const user = await fakeUser();
          expect(await getFeatureAccess(user.collective, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });
      });

      describe('with the new pricing', () => {
        it('is AVAILABLE for active hosts if opted in', async () => {
          const host = await fakeActiveHost();
          await fakePlatformSubscription({
            CollectiveId: host.id,
            plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
          });
        });

        it('is DISABLED if not accessible in the plan', async () => {
          const host = await fakeActiveHost();
          await fakePlatformSubscription({
            CollectiveId: host.id,
            plan: { features: { OFF_PLATFORM_TRANSACTIONS: false } },
          });
          expect(await getFeatureAccess(host, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'DISABLED',
            reason: 'PRICING',
          });
        });

        it('is supported for independent collectives', async () => {
          const collective = await fakeCollective({
            hasMoneyManagement: true,
            isActive: true,
          });
          await fakePlatformSubscription({
            CollectiveId: collective.id,
            plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
          });
          expect(await getFeatureAccess(collective, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });

        it('is UNSUPPORTED for users', async () => {
          const user = await fakeUser();
          expect(await getFeatureAccess(user.collective, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });
      });
    });

    describe('PAYPAL_DONATIONS', () => {
      it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({
          plan: 'start-plan-2021',
          data: { features: { [FEATURE.PAYPAL_DONATIONS]: true } },
        });
        expect(await getFeatureAccess(host, FEATURE.PAYPAL_DONATIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const notOpted = await fakeActiveHost({ plan: 'start-plan-2021' });
        expect(await getFeatureAccess(notOpted, FEATURE.PAYPAL_DONATIONS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.PAYPAL_DONATIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const flagOverride = await fakeActiveHost({
          plan: 'start-plan-2021',
          settings: { features: { paypalDonations: true } },
        });
        expect(await getFeatureAccess(flagOverride, FEATURE.PAYPAL_DONATIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
      });
    });

    describe('PAYPAL_PAYOUTS', () => {
      it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({
          plan: 'start-plan-2021',
          data: { features: { [FEATURE.PAYPAL_PAYOUTS]: true } },
        });
        expect(await getFeatureAccess(host, FEATURE.PAYPAL_PAYOUTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const notOpted = await fakeActiveHost({ plan: 'start-plan-2021' });
        expect(await getFeatureAccess(notOpted, FEATURE.PAYPAL_PAYOUTS)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.PAYPAL_PAYOUTS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const flagOverride = await fakeActiveHost({
          plan: 'start-plan-2021',
          settings: { features: { paypalPayouts: true } },
        });
        expect(await getFeatureAccess(flagOverride, FEATURE.PAYPAL_PAYOUTS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
      });
    });

    describe('PROJECTS', () => {
      it('is AVAILABLE for active funds, organizations, and collectives, UNSUPPORTED for others', async () => {
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true });
        expect(await getFeatureAccess(fund, FEATURE.PROJECTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const org = await fakeOrganization({ isActive: true });
        expect(await getFeatureAccess(org, FEATURE.PROJECTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const collective = await fakeCollective({ isActive: true });
        expect(await getFeatureAccess(collective, FEATURE.PROJECTS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const inactive = await fakeCollective({ type: CollectiveType.FUND, isActive: false });
        expect(await getFeatureAccess(inactive, FEATURE.PROJECTS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const user = await fakeUser({ isActive: true });
        expect(await getFeatureAccess(user.collective, FEATURE.PROJECTS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('RECEIVE_EXPENSES', () => {
      it('is AVAILABLE for allowed account types, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        expect(await getFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const collective = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        expect(await getFeatureAccess(collective, FEATURE.RECEIVE_EXPENSES)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const inactiveHost = await fakeCollective({
          plan: 'start-plan-2021',
          hasMoneyManagement: true,
          isActive: false,
        });
        expect(await getFeatureAccess(inactiveHost, FEATURE.RECEIVE_EXPENSES)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.RECEIVE_EXPENSES)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('RECEIVE_FINANCIAL_CONTRIBUTIONS', () => {
      it('is AVAILABLE for active hosts of allowed account types, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        expect(await getFeatureAccess(host, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const collective = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        expect(await getFeatureAccess(collective, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const inactiveHost = await fakeHost({ plan: 'start-plan-2021', hasMoneyManagement: true, isActive: false });
        expect(await getFeatureAccess(inactiveHost, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('RECEIVE_HOST_APPLICATIONS', () => {
      describe('with the legacy pricing', () => {
        it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
          const host = await fakeActiveHost({
            plan: 'start-plan-2021',
            data: { features: { [FEATURE.RECEIVE_HOST_APPLICATIONS]: true } },
            hasHosting: true,
          });
          expect(await getFeatureAccess(host, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
          const notOpted = await fakeActiveHost({ hasHosting: true, plan: 'start-plan-2021' });
          expect(await getFeatureAccess(notOpted, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'DISABLED',
            reason: 'OPT_IN',
          });
          const org = await fakeOrganization({ hasHosting: true, plan: 'start-plan-2021' });
          expect(await getFeatureAccess(org, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
          const flagOverride = await fakeActiveHost({
            hasHosting: true,
            plan: 'start-plan-2021',
            settings: { apply: true },
          });
          expect(await getFeatureAccess(flagOverride, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });
      });

      describe('with the new pricing', () => {
        it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
          const host = await fakeActiveHost({ hasHosting: true, settings: { apply: true } });
          await fakePlatformSubscription({
            CollectiveId: host.id,
            plan: { features: { RECEIVE_HOST_APPLICATIONS: true } },
          });
          expect(await getFeatureAccess(host, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'AVAILABLE',
            reason: null,
          });
        });

        it('is DISABLED if not opted in', async () => {
          const host = await fakeActiveHost({ hasHosting: true });
          await fakePlatformSubscription({
            CollectiveId: host.id,
            plan: { features: { RECEIVE_HOST_APPLICATIONS: true } },
          });
          expect(await getFeatureAccess(host, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'DISABLED',
            reason: 'OPT_IN',
          });
        });

        it('is UNSUPPORTED for organizations without hosting', async () => {
          const org = await fakeActiveHost({ hasHosting: false });
          expect(await getFeatureAccess(org, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });

        it('is UNSUPPORTED for users', async () => {
          const user = await fakeUser();
          expect(await getFeatureAccess(user.collective, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });
      });
    });

    describe('RECURRING_CONTRIBUTIONS', () => {
      it('is AVAILABLE for users, organizations, collectives, and funds, UNSUPPORTED for others', async () => {
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(await getFeatureAccess(fund, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const project = await fakeProject();
        expect(await getFeatureAccess(project, FEATURE.RECURRING_CONTRIBUTIONS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('STRIPE_PAYMENT_INTENT', () => {
      it('is AVAILABLE if opted in, DISABLED if not', async () => {
        const collective = await fakeCollective({ data: { features: { [FEATURE.STRIPE_PAYMENT_INTENT]: true } } });
        expect(await getFeatureAccess(collective, FEATURE.STRIPE_PAYMENT_INTENT)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const notOpted = await fakeCollective({});
        expect(await getFeatureAccess(notOpted, FEATURE.STRIPE_PAYMENT_INTENT)).to.deep.eq({
          access: 'DISABLED',
          reason: 'OPT_IN',
        });
        const flagOverride = await fakeCollective({ settings: { features: { stripePaymentIntent: true } } });
        expect(await getFeatureAccess(flagOverride, FEATURE.STRIPE_PAYMENT_INTENT)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
      });
    });

    describe('TEAM', () => {
      it('is AVAILABLE for multi-admin account types, UNSUPPORTED for others', async () => {
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.TEAM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.TEAM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.TEAM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(await getFeatureAccess(fund, FEATURE.TEAM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const project = await fakeProject();
        expect(await getFeatureAccess(project, FEATURE.TEAM)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.TEAM)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('TAX_FORMS', () => {
      it('is unsupported for non-US accounts', async () => {
        const org = await fakeActiveHost({ countryISO: 'FR' });
        expect(await getFeatureAccess(org, FEATURE.TAX_FORMS)).to.deep.eq({ access: 'UNSUPPORTED', reason: 'REGION' });
        const org2 = await fakeActiveHost({ countryISO: null });
        expect(await getFeatureAccess(org2, FEATURE.TAX_FORMS)).to.deep.eq({ access: 'UNSUPPORTED', reason: 'REGION' });
      });

      it('is supported for US accounts', async () => {
        const org = await fakeActiveHost({ countryISO: 'US' });
        await fakePlatformSubscription({ CollectiveId: org.id, plan: { features: { TAX_FORMS: true } } });
        expect(await getFeatureAccess(org, FEATURE.TAX_FORMS)).to.deep.eq({ access: 'AVAILABLE', reason: null });
      });
    });

    describe('TOP_FINANCIAL_CONTRIBUTORS', () => {
      it('is AVAILABLE for collectives, organizations, and funds, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(await getFeatureAccess(fund, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('TRANSFERWISE', () => {
      describe('with the legacy pricing', () => {
        it('is AVAILABLE for active hosts', async () => {
          const host = await fakeActiveHost({ plan: 'start-plan-2021' });
          expect(await getFeatureAccess(host, FEATURE.TRANSFERWISE)).to.deep.eq({ access: 'AVAILABLE', reason: null });
          const inactiveHost = await fakeCollective({ hasMoneyManagement: true, isActive: false });
          expect(await getFeatureAccess(inactiveHost, FEATURE.TRANSFERWISE)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });

        it('is UNSUPPORTED for non-host users', async () => {
          const user = await fakeUser();
          expect(await getFeatureAccess(user.collective, FEATURE.TRANSFERWISE)).to.deep.eq({
            access: 'UNSUPPORTED',
            reason: 'ACCOUNT_TYPE',
          });
        });
      });

      describe('with the new pricing', () => {
        it('is AVAILABLE for active hosts', async () => {
          const host = await fakeActiveHost();
          await fakePlatformSubscription({ CollectiveId: host.id, plan: { features: { TRANSFERWISE: true } } });
          expect(await getFeatureAccess(host, FEATURE.TRANSFERWISE)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        });
      });
    });

    describe('UPDATES', () => {
      it('is AVAILABLE for collectives, organizations, funds, projects, and events, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.UPDATES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.UPDATES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(await getFeatureAccess(fund, FEATURE.UPDATES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const project = await fakeProject();
        expect(await getFeatureAccess(project, FEATURE.UPDATES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.UPDATES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.UPDATES)).to.deep.eq({
          access: 'UNSUPPORTED',
          reason: 'ACCOUNT_TYPE',
        });
      });
    });

    describe('USE_EXPENSES', () => {
      it('is AVAILABLE for all account types, UNSUPPORTED for none', async () => {
        const user = await fakeUser();
        expect(await getFeatureAccess(user.collective, FEATURE.USE_EXPENSES)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const org = await fakeOrganization();
        expect(await getFeatureAccess(org, FEATURE.USE_EXPENSES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const collective = await fakeCollective();
        expect(await getFeatureAccess(collective, FEATURE.USE_EXPENSES)).to.deep.eq({
          access: 'AVAILABLE',
          reason: null,
        });
        const event = await fakeEvent();
        expect(await getFeatureAccess(event, FEATURE.USE_EXPENSES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(await getFeatureAccess(fund, FEATURE.USE_EXPENSES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
        const project = await fakeProject();
        expect(await getFeatureAccess(project, FEATURE.USE_EXPENSES)).to.deep.eq({ access: 'AVAILABLE', reason: null });
      });
    });
  });

  // Assert the default permissions for each account type
  describe('getFeaturesAccessMap', () => {
    describe('USER', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CONVERSATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_EXPENSES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_GRANTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
      };

      it('for a simple user', async () => {
        const user = await fakeUser(null, { countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(user.collective);
        expect(featuresMap).to.deep.equal(basePermissions);
      });

      it('for a HOST user', async () => {
        const user = await fakeUser({}, { plan: 'start-plan-2021', hasMoneyManagement: true, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(user.collective);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        });
      });
    });

    describe('ORGANIZATION', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'DISABLED', reason: 'OPT_IN' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'AVAILABLE', reason: null },
        CONVERSATIONS: { access: 'AVAILABLE', reason: null },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'AVAILABLE', reason: null },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_EXPENSES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_GRANTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'AVAILABLE', reason: null },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'AVAILABLE', reason: null },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'AVAILABLE', reason: null },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'AVAILABLE', reason: null },
        CHARGE_HOSTING_FEES: { access: 'AVAILABLE', reason: null },
        CHART_OF_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        EXPECTED_FUNDS: { access: 'AVAILABLE', reason: null },
        EXPENSE_SECURITY_CHECKS: { access: 'AVAILABLE', reason: null },
        FUNDS_GRANTS_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        TAX_FORMS: { access: 'AVAILABLE', reason: null },
        VENDORS: { access: 'AVAILABLE', reason: null },
      };

      it('for a HOST organization', async () => {
        const hostOrg = await fakeActiveHost({
          plan: 'start-plan-2021',
          type: CollectiveType.ORGANIZATION,
          countryISO: 'US',
          hasHosting: true,
        });
        const featuresMap = await getFeaturesAccessMap(hostOrg);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          ALIPAY: { access: 'AVAILABLE', reason: null },
          HOST_DASHBOARD: { access: 'AVAILABLE', reason: null },
          OFF_PLATFORM_TRANSACTIONS: { access: 'DISABLED', reason: 'OPT_IN' },
          PAYPAL_DONATIONS: { access: 'DISABLED', reason: 'OPT_IN' },
          PAYPAL_PAYOUTS: { access: 'DISABLED', reason: 'OPT_IN' },
          RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
          RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
          RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
          RECEIVE_HOST_APPLICATIONS: { access: 'DISABLED', reason: 'OPT_IN' },
          TRANSFERWISE: { access: 'AVAILABLE', reason: null },
        });
      });
    });

    describe('COLLECTIVE', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'DISABLED', reason: 'OPT_IN' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'AVAILABLE', reason: null },
        CONVERSATIONS: { access: 'AVAILABLE', reason: null },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'AVAILABLE', reason: null },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
        RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'AVAILABLE', reason: null },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'AVAILABLE', reason: null },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'AVAILABLE', reason: null },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
      };

      it('for a hosted collective', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021', countryISO: 'US' });
        const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(collective);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
        });
      });

      it('for a self-hosted collective', async () => {
        const selfHosted = await fakeCollective({
          plan: 'start-plan-2021',
          hasMoneyManagement: true,
          isActive: true,
          countryISO: 'US',
        });
        const featuresMap = await getFeaturesAccessMap(selfHosted);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          ALIPAY: { access: 'AVAILABLE', reason: null },
          CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CHART_OF_ACCOUNTS: { access: 'AVAILABLE', reason: null },
          EXPECTED_FUNDS: { access: 'AVAILABLE', reason: null },
          EXPENSE_SECURITY_CHECKS: { access: 'AVAILABLE', reason: null },
          FUNDS_GRANTS_MANAGEMENT: { access: 'AVAILABLE', reason: null },
          HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          PAYPAL_DONATIONS: { access: 'DISABLED', reason: 'OPT_IN' },
          PAYPAL_PAYOUTS: { access: 'DISABLED', reason: 'OPT_IN' },
          RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
          RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
          RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
          RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          TAX_FORMS: { access: 'AVAILABLE', reason: null },
          TRANSFERWISE: { access: 'AVAILABLE', reason: null },
          VENDORS: { access: 'AVAILABLE', reason: null },
          OFF_PLATFORM_TRANSACTIONS: { access: 'DISABLED', reason: 'OPT_IN' },
        });
      });

      it('for an unhosted collective', async () => {
        const unhosted = await fakeCollective({ isActive: false, HostCollectiveId: null, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(unhosted);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          COLLECTIVE_GOALS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          CONTACT_FORM: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          EVENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          PROJECTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
          VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        });
      });
    });

    describe('FUND', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'AVAILABLE', reason: null },
        CONVERSATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
        RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'AVAILABLE', reason: null },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'AVAILABLE', reason: null },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'AVAILABLE', reason: null },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
      };

      it('for an active fund', async () => {
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(fund);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });

    describe('PROJECT', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'DISABLED', reason: 'OPT_IN' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'AVAILABLE', reason: null },
        CONVERSATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
        RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'AVAILABLE', reason: null },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'AVAILABLE', reason: null },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
      };

      it('for an active project', async () => {
        const project = await fakeProject({ isActive: true, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(project);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });

    describe('EVENT', () => {
      const basePermissions = {
        ABOUT: { access: 'AVAILABLE', reason: null },
        ALIPAY: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        COLLECTIVE_GOALS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CONNECTED_ACCOUNTS: { access: 'AVAILABLE', reason: null },
        CONTACT_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        CONTACT_FORM: { access: 'AVAILABLE', reason: null },
        CONVERSATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CREATE_COLLECTIVE: { access: 'AVAILABLE', reason: null },
        EMAIL_NOTIFICATIONS_PANEL: { access: 'AVAILABLE', reason: null },
        EMIT_GIFT_CARDS: { access: 'AVAILABLE', reason: null },
        EVENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        HOST_DASHBOARD: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PERSONA_KYC: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        MULTI_CURRENCY_EXPENSES: { access: 'AVAILABLE', reason: null },
        OFF_PLATFORM_TRANSACTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        ORDER: { access: 'AVAILABLE', reason: null },
        PAYPAL_DONATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PAYPAL_PAYOUTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        PROJECTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECEIVE_EXPENSES: { access: 'AVAILABLE', reason: null },
        RECEIVE_GRANTS: { access: 'AVAILABLE', reason: null },
        RECEIVE_FINANCIAL_CONTRIBUTIONS: { access: 'AVAILABLE', reason: null },
        RECEIVE_HOST_APPLICATIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        RECURRING_CONTRIBUTIONS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        REQUEST_VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },
        STRIPE_PAYMENT_INTENT: { access: 'DISABLED', reason: 'OPT_IN' },
        TEAM: { access: 'AVAILABLE', reason: null },
        TOP_FINANCIAL_CONTRIBUTORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TRANSACTIONS: { access: 'AVAILABLE', reason: null },
        TRANSFERWISE: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        UPDATES: { access: 'AVAILABLE', reason: null },
        USE_EXPENSES: { access: 'AVAILABLE', reason: null },
        USE_PAYMENT_METHODS: { access: 'AVAILABLE', reason: null },
        VIRTUAL_CARDS: { access: 'AVAILABLE', reason: null },

        ACCOUNT_MANAGEMENT: { access: 'AVAILABLE', reason: null },
        AGREEMENTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHARGE_HOSTING_FEES: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        CHART_OF_ACCOUNTS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPECTED_FUNDS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        EXPENSE_SECURITY_CHECKS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        FUNDS_GRANTS_MANAGEMENT: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        TAX_FORMS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
        VENDORS: { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' },
      };

      it('for an active event', async () => {
        const event = await fakeEvent({ isActive: true, countryISO: 'US' });
        const featuresMap = await getFeaturesAccessMap(event);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });
  });

  describe('checkFeatureAccess', () => {
    describe('with the legacy pricing', () => {
      it('should throw an error if the feature is unsupported by the account type', async () => {
        const user = await fakeUser();
        await expect(checkFeatureAccess(user.collective, FEATURE.RECEIVE_EXPENSES)).to.be.rejectedWith(
          'This feature is not supported for your account',
        );
      });

      it('should throw an error if the feature is disabled for the account', async () => {
        const host = await fakeActiveHost({
          plan: 'start-plan-2021',
          data: { features: { [FEATURE.RECEIVE_EXPENSES]: false } },
        });
        await expect(checkFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.be.rejectedWith(
          'This feature is not enabled for your account',
        );
      });

      it('should throw an error if the feature is not enabled for the account', async () => {
        const host = await fakeActiveHost({
          plan: 'start-plan-2021',
          data: { features: { [FEATURE.RECEIVE_EXPENSES]: false } },
        });
        await expect(checkFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.be.rejectedWith(
          'This feature is not enabled for your account',
        );
      });

      it('should not throw an error if the feature is available', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        await expect(checkFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.be.fulfilled;
      });

      it('should not throw when using a legacy pricing', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        await expect(checkFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.be.fulfilled;
      });
    });

    describe('with the new pricing', () => {
      it('should not throw an error if the feature is not available for free', async () => {
        const host = await fakeActiveHost();
        await fakePlatformSubscription({
          CollectiveId: host.id,
          plan: { features: { RECEIVE_EXPENSES: false } },
        });
        await expect(checkFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.be.fulfilled;
      });

      it('should throw an error if the feature is not available in the current plan', async () => {
        const host = await fakeActiveHost();
        await fakePlatformSubscription({
          CollectiveId: host.id,
          plan: { features: { TRANSFERWISE: false } },
        });
        await expect(checkFeatureAccess(host, FEATURE.TRANSFERWISE)).to.be.rejectedWith(
          'This feature is not available in your current plan',
        );
      });

      it('should not throw an error if the feature is available in the current plan', async () => {
        const host = await fakeActiveHost();
        await fakePlatformSubscription({
          CollectiveId: host.id,
          plan: { features: { TRANSFERWISE: true } },
        });
        await expect(checkFeatureAccess(host, FEATURE.TRANSFERWISE)).to.be.fulfilled;
      });
    });
  });
});
