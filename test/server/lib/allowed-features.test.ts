import { expect } from 'chai';

import { CollectiveType } from '../../../server/constants/collectives';
import FEATURE from '../../../server/constants/feature';
import PlatformConstants from '../../../server/constants/platform';
import { getCollectiveFeaturesMap, getFeatureAccess } from '../../../server/lib/allowed-features';
import { Collective } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeOrganization,
  fakeProject,
  fakeUser,
} from '../../test-helpers/fake-data';

describe('server/lib/allowed-features', () => {
  let platform;

  before(async () => {
    platform = await Collective.findByPk(PlatformConstants.PlatformCollectiveId);
    if (!platform) {
      platform = await fakeActiveHost({ id: PlatformConstants.PlatformCollectiveId });
    }
  });

  describe('getFeatureAccess', () => {
    it('returns UNSUPPORTED if collective is null', () => {
      expect(getFeatureAccess(null, FEATURE.CONVERSATIONS)).to.eq('UNSUPPORTED');
    });

    it('returns DISABLED if collective is suspended', async () => {
      const collective = await fakeCollective({ data: { isSuspended: true } });
      expect(getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.eq('DISABLED');
    });

    it('returns DISABLED if feature is globally blocked', async () => {
      const collective = await fakeCollective({ data: { features: { ALL: false } } });
      expect(getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.eq('DISABLED');
    });

    it('returns DISABLED if feature is specifically blocked', async () => {
      const collective = await fakeCollective({ data: { features: { [FEATURE.CONVERSATIONS]: false } } });
      expect(getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.eq('DISABLED');
    });

    describe('ALIPAY', () => {
      it('is AVAILABLE for active hosts, UNSUPPORTED otherwise', async () => {
        const host = await fakeActiveHost();
        expect(getFeatureAccess(host, FEATURE.ALIPAY)).to.eq('AVAILABLE');
        const inactiveHost = await fakeCollective({ isHostAccount: true, isActive: false });
        expect(getFeatureAccess(inactiveHost, FEATURE.ALIPAY)).to.eq('UNSUPPORTED');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.ALIPAY)).to.eq('UNSUPPORTED');
      });
    });

    describe('COLLECTIVE_GOALS', () => {
      it('is DISABLED for active collectives/orgs/projects by default (opt-in), AVAILABLE if opted in, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({ isActive: true });
        expect(getFeatureAccess(collective, FEATURE.COLLECTIVE_GOALS)).to.eq('DISABLED');
        const org = await fakeOrganization({ isActive: true });
        expect(getFeatureAccess(org, FEATURE.COLLECTIVE_GOALS)).to.eq('DISABLED');
        const project = await fakeProject({ isActive: true });
        expect(getFeatureAccess(project, FEATURE.COLLECTIVE_GOALS)).to.eq('DISABLED');
        const event = await fakeEvent({ isActive: true });
        expect(getFeatureAccess(event, FEATURE.COLLECTIVE_GOALS)).to.eq('UNSUPPORTED');
        const optedIn = await fakeCollective({
          isActive: true,
          data: { features: { [FEATURE.COLLECTIVE_GOALS]: true } },
        });
        expect(getFeatureAccess(optedIn, FEATURE.COLLECTIVE_GOALS)).to.eq('AVAILABLE');
        const flagOverride = await fakeCollective({
          isActive: true,
          settings: { collectivePage: { showGoals: true } },
        });
        expect(getFeatureAccess(flagOverride, FEATURE.COLLECTIVE_GOALS)).to.eq('AVAILABLE');
        const disabled = await fakeCollective({
          isActive: true,
          data: { features: { [FEATURE.COLLECTIVE_GOALS]: false } },
        });
        expect(getFeatureAccess(disabled, FEATURE.COLLECTIVE_GOALS)).to.eq('DISABLED');
        const flagOverrideDisabled = await fakeCollective({
          isActive: true,
          settings: { collectivePage: { showGoals: false } },
        });
        expect(getFeatureAccess(flagOverrideDisabled, FEATURE.COLLECTIVE_GOALS)).to.eq('DISABLED');
      });
    });

    describe('CONTACT_FORM', () => {
      it('is AVAILABLE for active accounts of allowed types, DISABLED if opted out, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({
          isActive: true,
        });
        expect(getFeatureAccess(collective, FEATURE.CONTACT_FORM)).to.eq('AVAILABLE');
        const org = await fakeOrganization({ isActive: true });
        expect(getFeatureAccess(org, FEATURE.CONTACT_FORM)).to.eq('AVAILABLE');
        const event = await fakeEvent({ isActive: true });
        expect(getFeatureAccess(event, FEATURE.CONTACT_FORM)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true });
        expect(getFeatureAccess(fund, FEATURE.CONTACT_FORM)).to.eq('AVAILABLE');
        const project = await fakeProject({ isActive: true });
        expect(getFeatureAccess(project, FEATURE.CONTACT_FORM)).to.eq('AVAILABLE');
        const user = await fakeUser({ isActive: true });
        expect(getFeatureAccess(user.collective, FEATURE.CONTACT_FORM)).to.eq('UNSUPPORTED');
        const inactive = await fakeCollective({
          isActive: false,
        });
        expect(getFeatureAccess(inactive, FEATURE.CONTACT_FORM)).to.eq('UNSUPPORTED');
        const disabled = await fakeCollective({
          isActive: true,

          data: { features: { [FEATURE.CONTACT_FORM]: false } },
        });
        expect(getFeatureAccess(disabled, FEATURE.CONTACT_FORM)).to.eq('DISABLED');
        const flagOverride = await fakeCollective({
          isActive: true,
          settings: { features: { contactForm: false } },
        });
        expect(getFeatureAccess(flagOverride, FEATURE.CONTACT_FORM)).to.eq('DISABLED');
      });
    });

    describe('CONVERSATIONS', () => {
      it('is AVAILABLE for collectives and organizations, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.CONVERSATIONS)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.CONVERSATIONS)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.CONVERSATIONS)).to.eq('UNSUPPORTED');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.CONVERSATIONS)).to.eq('UNSUPPORTED');
      });
    });

    describe('EVENTS', () => {
      it('is AVAILABLE for active collectives and organizations, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective({ isActive: true });
        expect(getFeatureAccess(collective, FEATURE.EVENTS)).to.eq('AVAILABLE');
        const org = await fakeOrganization({ isActive: true });
        expect(getFeatureAccess(org, FEATURE.EVENTS)).to.eq('AVAILABLE');
        const inactive = await fakeCollective({ isActive: false });
        expect(getFeatureAccess(inactive, FEATURE.EVENTS)).to.eq('UNSUPPORTED');
        const user = await fakeUser({ isActive: true });
        expect(getFeatureAccess(user.collective, FEATURE.EVENTS)).to.eq('UNSUPPORTED');
      });
    });

    describe('HOST_DASHBOARD', () => {
      it('is AVAILABLE for hosts, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost();
        expect(getFeatureAccess(host, FEATURE.HOST_DASHBOARD)).to.eq('AVAILABLE');
        const inactiveHost = await fakeCollective({ isHostAccount: true, isActive: false });
        expect(getFeatureAccess(inactiveHost, FEATURE.HOST_DASHBOARD)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.HOST_DASHBOARD)).to.eq('UNSUPPORTED');
      });
    });

    describe('OFF_PLATFORM_TRANSACTIONS', () => {
      it('is AVAILABLE for platform orgs by default, DISABLED for others unless opted in', async () => {
        expect(getFeatureAccess(platform, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.eq('UNSUPPORTED');
        const optedIn = await fakeActiveHost({ data: { features: { [FEATURE.OFF_PLATFORM_TRANSACTIONS]: true } } });
        expect(getFeatureAccess(optedIn, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.OFF_PLATFORM_TRANSACTIONS)).to.eq('UNSUPPORTED');
      });
    });

    describe('PAYPAL_DONATIONS', () => {
      it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({ data: { features: { [FEATURE.PAYPAL_DONATIONS]: true } } });
        expect(getFeatureAccess(host, FEATURE.PAYPAL_DONATIONS)).to.eq('AVAILABLE');
        const notOpted = await fakeActiveHost();
        expect(getFeatureAccess(notOpted, FEATURE.PAYPAL_DONATIONS)).to.eq('DISABLED');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.PAYPAL_DONATIONS)).to.eq('UNSUPPORTED');
        const flagOverride = await fakeActiveHost({ settings: { features: { paypalDonations: true } } });
        expect(getFeatureAccess(flagOverride, FEATURE.PAYPAL_DONATIONS)).to.eq('AVAILABLE');
      });
    });

    describe('PAYPAL_PAYOUTS', () => {
      it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({ data: { features: { [FEATURE.PAYPAL_PAYOUTS]: true } } });
        expect(getFeatureAccess(host, FEATURE.PAYPAL_PAYOUTS)).to.eq('AVAILABLE');
        const notOpted = await fakeActiveHost();
        expect(getFeatureAccess(notOpted, FEATURE.PAYPAL_PAYOUTS)).to.eq('DISABLED');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.PAYPAL_PAYOUTS)).to.eq('UNSUPPORTED');
        const flagOverride = await fakeActiveHost({ settings: { features: { paypalPayouts: true } } });
        expect(getFeatureAccess(flagOverride, FEATURE.PAYPAL_PAYOUTS)).to.eq('AVAILABLE');
      });
    });

    describe('PROJECTS', () => {
      it('is AVAILABLE for active funds, organizations, and collectives, UNSUPPORTED for others', async () => {
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true });
        expect(getFeatureAccess(fund, FEATURE.PROJECTS)).to.eq('AVAILABLE');
        const org = await fakeOrganization({ isActive: true });
        expect(getFeatureAccess(org, FEATURE.PROJECTS)).to.eq('AVAILABLE');
        const collective = await fakeCollective({ isActive: true });
        expect(getFeatureAccess(collective, FEATURE.PROJECTS)).to.eq('AVAILABLE');
        const inactive = await fakeCollective({ type: CollectiveType.FUND, isActive: false });
        expect(getFeatureAccess(inactive, FEATURE.PROJECTS)).to.eq('UNSUPPORTED');
        const user = await fakeUser({ isActive: true });
        expect(getFeatureAccess(user.collective, FEATURE.PROJECTS)).to.eq('UNSUPPORTED');
      });
    });

    describe('RECEIVE_EXPENSES', () => {
      it('is AVAILABLE for active hosts of allowed account types, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost();
        expect(getFeatureAccess(host, FEATURE.RECEIVE_EXPENSES)).to.eq('AVAILABLE');
        const collective = await fakeCollective({ isActive: true });
        expect(getFeatureAccess(collective, FEATURE.RECEIVE_EXPENSES)).to.eq('AVAILABLE');
        const inactiveHost = await fakeCollective({ isHostAccount: true, isActive: false });
        expect(getFeatureAccess(inactiveHost, FEATURE.RECEIVE_EXPENSES)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.RECEIVE_EXPENSES)).to.eq('UNSUPPORTED');
      });
    });

    describe('RECEIVE_FINANCIAL_CONTRIBUTIONS', () => {
      it('is AVAILABLE for active hosts of allowed account types, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost();
        expect(getFeatureAccess(host, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const collective = await fakeCollective({ isActive: true });
        expect(getFeatureAccess(collective, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const inactiveHost = await fakeCollective({ isHostAccount: true, isActive: false });
        expect(getFeatureAccess(inactiveHost, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.eq('UNSUPPORTED');
      });
    });

    describe('RECEIVE_HOST_APPLICATIONS', () => {
      it('is AVAILABLE for active hosts if opted in, DISABLED if not, UNSUPPORTED for others', async () => {
        const host = await fakeActiveHost({ data: { features: { [FEATURE.RECEIVE_HOST_APPLICATIONS]: true } } });
        expect(getFeatureAccess(host, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.eq('AVAILABLE');
        const notOpted = await fakeActiveHost();
        expect(getFeatureAccess(notOpted, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.eq('DISABLED');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.eq('UNSUPPORTED');
        const flagOverride = await fakeActiveHost({ settings: { apply: true } });
        expect(getFeatureAccess(flagOverride, FEATURE.RECEIVE_HOST_APPLICATIONS)).to.eq('AVAILABLE');
      });
    });

    describe('RECURRING_CONTRIBUTIONS', () => {
      it('is AVAILABLE for users, organizations, collectives, and funds, UNSUPPORTED for others', async () => {
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(getFeatureAccess(fund, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('AVAILABLE');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('UNSUPPORTED');
        const project = await fakeProject();
        expect(getFeatureAccess(project, FEATURE.RECURRING_CONTRIBUTIONS)).to.eq('UNSUPPORTED');
      });
    });

    describe('STRIPE_PAYMENT_INTENT', () => {
      it('is AVAILABLE if opted in, DISABLED if not', async () => {
        const collective = await fakeCollective({ data: { features: { [FEATURE.STRIPE_PAYMENT_INTENT]: true } } });
        expect(getFeatureAccess(collective, FEATURE.STRIPE_PAYMENT_INTENT)).to.eq('AVAILABLE');
        const notOpted = await fakeCollective({});
        expect(getFeatureAccess(notOpted, FEATURE.STRIPE_PAYMENT_INTENT)).to.eq('DISABLED');
        const flagOverride = await fakeCollective({ settings: { features: { stripePaymentIntent: true } } });
        expect(getFeatureAccess(flagOverride, FEATURE.STRIPE_PAYMENT_INTENT)).to.eq('AVAILABLE');
      });
    });

    describe('TEAM', () => {
      it('is AVAILABLE for multi-admin account types, UNSUPPORTED for others', async () => {
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.TEAM)).to.eq('AVAILABLE');
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.TEAM)).to.eq('AVAILABLE');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.TEAM)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(getFeatureAccess(fund, FEATURE.TEAM)).to.eq('AVAILABLE');
        const project = await fakeProject();
        expect(getFeatureAccess(project, FEATURE.TEAM)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.TEAM)).to.eq('UNSUPPORTED');
      });
    });

    describe('TOP_FINANCIAL_CONTRIBUTORS', () => {
      it('is AVAILABLE for collectives, organizations, and funds, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(getFeatureAccess(fund, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.eq('UNSUPPORTED');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.eq('UNSUPPORTED');
      });
    });

    describe('TRANSFERWISE', () => {
      it('is AVAILABLE for active hosts, UNSUPPORTED otherwise', async () => {
        const host = await fakeActiveHost();
        expect(getFeatureAccess(host, FEATURE.TRANSFERWISE)).to.eq('AVAILABLE');
        const inactiveHost = await fakeCollective({ isHostAccount: true, isActive: false });
        expect(getFeatureAccess(inactiveHost, FEATURE.TRANSFERWISE)).to.eq('UNSUPPORTED');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.TRANSFERWISE)).to.eq('UNSUPPORTED');
      });
    });

    describe('UPDATES', () => {
      it('is AVAILABLE for collectives, organizations, funds, projects, and events, UNSUPPORTED for others', async () => {
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.UPDATES)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.UPDATES)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(getFeatureAccess(fund, FEATURE.UPDATES)).to.eq('AVAILABLE');
        const project = await fakeProject();
        expect(getFeatureAccess(project, FEATURE.UPDATES)).to.eq('AVAILABLE');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.UPDATES)).to.eq('AVAILABLE');
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.UPDATES)).to.eq('UNSUPPORTED');
      });
    });

    describe('USE_EXPENSES', () => {
      it('is AVAILABLE for all account types, UNSUPPORTED for none', async () => {
        const user = await fakeUser();
        expect(getFeatureAccess(user.collective, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
        const org = await fakeOrganization();
        expect(getFeatureAccess(org, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
        const collective = await fakeCollective();
        expect(getFeatureAccess(collective, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
        const event = await fakeEvent();
        expect(getFeatureAccess(event, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
        const fund = await fakeCollective({ type: CollectiveType.FUND });
        expect(getFeatureAccess(fund, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
        const project = await fakeProject();
        expect(getFeatureAccess(project, FEATURE.USE_EXPENSES)).to.eq('AVAILABLE');
      });
    });
  });

  describe('getCollectiveFeaturesMap', () => {
    describe('USER', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'UNSUPPORTED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'UNSUPPORTED',
        CONVERSATIONS: 'UNSUPPORTED',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'UNSUPPORTED',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'UNSUPPORTED',
        RECEIVE_EXPENSES: 'UNSUPPORTED',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'UNSUPPORTED',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'AVAILABLE',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'UNSUPPORTED',
        TOP_FINANCIAL_CONTRIBUTORS: 'UNSUPPORTED',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'UNSUPPORTED',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for a simple user', async () => {
        const user = await fakeUser();
        const featuresMap = getCollectiveFeaturesMap(user.collective);
        expect(featuresMap).to.deep.equal(basePermissions);
      });

      it('for a HOST user', async () => {
        const user = await fakeUser({}, { isHostAccount: true });
        const featuresMap = getCollectiveFeaturesMap(user.collective);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          ALIPAY: 'AVAILABLE',
          HOST_DASHBOARD: 'AVAILABLE',
          PAYPAL_DONATIONS: 'DISABLED',
          PAYPAL_PAYOUTS: 'DISABLED',
          RECEIVE_HOST_APPLICATIONS: 'DISABLED',
          TRANSFERWISE: 'AVAILABLE',
        });
      });
    });

    describe('ORGANIZATION', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'DISABLED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'AVAILABLE',
        CONVERSATIONS: 'AVAILABLE',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'AVAILABLE',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'AVAILABLE',
        RECEIVE_EXPENSES: 'UNSUPPORTED',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'UNSUPPORTED',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'AVAILABLE',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'AVAILABLE',
        TOP_FINANCIAL_CONTRIBUTORS: 'AVAILABLE',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'AVAILABLE',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for a HOST organization', async () => {
        const hostOrg = await fakeActiveHost({ type: CollectiveType.ORGANIZATION });
        const featuresMap = getCollectiveFeaturesMap(hostOrg);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          ALIPAY: 'AVAILABLE',
          HOST_DASHBOARD: 'AVAILABLE',
          OFF_PLATFORM_TRANSACTIONS: 'DISABLED',
          PAYPAL_DONATIONS: 'DISABLED',
          PAYPAL_PAYOUTS: 'DISABLED',
          RECEIVE_EXPENSES: 'AVAILABLE',
          RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
          RECEIVE_HOST_APPLICATIONS: 'DISABLED',
          TRANSFERWISE: 'AVAILABLE',
        });
      });
    });

    describe('COLLECTIVE', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'DISABLED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'AVAILABLE',
        CONVERSATIONS: 'AVAILABLE',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'AVAILABLE',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'AVAILABLE',
        RECEIVE_EXPENSES: 'AVAILABLE',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'AVAILABLE',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'AVAILABLE',
        TOP_FINANCIAL_CONTRIBUTORS: 'AVAILABLE',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'AVAILABLE',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for a hosted collective', async () => {
        const host = await fakeActiveHost();
        const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
        const featuresMap = getCollectiveFeaturesMap(collective);
        expect(featuresMap).to.deep.equal(basePermissions);
      });

      it('for a self-hosted collective', async () => {
        const selfHosted = await fakeActiveHost({ type: CollectiveType.COLLECTIVE });
        const featuresMap = getCollectiveFeaturesMap(selfHosted);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          ALIPAY: 'AVAILABLE',
          HOST_DASHBOARD: 'AVAILABLE',
          PAYPAL_DONATIONS: 'DISABLED',
          PAYPAL_PAYOUTS: 'DISABLED',
          RECEIVE_EXPENSES: 'AVAILABLE',
          RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
          RECEIVE_HOST_APPLICATIONS: 'DISABLED',
          TRANSFERWISE: 'AVAILABLE',
        });
      });

      it('for an unhosted collective', async () => {
        const unhosted = await fakeCollective({ isActive: false, HostCollectiveId: null });
        const featuresMap = getCollectiveFeaturesMap(unhosted);
        expect(featuresMap).to.deep.equal({
          ...basePermissions,
          CONTACT_FORM: 'UNSUPPORTED',
          EVENTS: 'UNSUPPORTED',
          PROJECTS: 'UNSUPPORTED',
          COLLECTIVE_GOALS: 'UNSUPPORTED',
        });
      });
    });

    describe('FUND', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'UNSUPPORTED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'AVAILABLE',
        CONVERSATIONS: 'UNSUPPORTED',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'UNSUPPORTED',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'AVAILABLE',
        RECEIVE_EXPENSES: 'AVAILABLE',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'AVAILABLE',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'AVAILABLE',
        TOP_FINANCIAL_CONTRIBUTORS: 'AVAILABLE',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'AVAILABLE',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for an active fund', async () => {
        const fund = await fakeCollective({ type: CollectiveType.FUND, isActive: true });
        const featuresMap = getCollectiveFeaturesMap(fund);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });

    describe('PROJECT', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'DISABLED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'AVAILABLE',
        CONVERSATIONS: 'UNSUPPORTED',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'UNSUPPORTED',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'UNSUPPORTED',
        RECEIVE_EXPENSES: 'AVAILABLE',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'UNSUPPORTED',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'AVAILABLE',
        TOP_FINANCIAL_CONTRIBUTORS: 'UNSUPPORTED',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'AVAILABLE',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for an active project', async () => {
        const project = await fakeProject({ isActive: true });
        const featuresMap = getCollectiveFeaturesMap(project);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });

    describe('EVENT', () => {
      const basePermissions = {
        ABOUT: 'AVAILABLE',
        ALIPAY: 'UNSUPPORTED',
        COLLECTIVE_GOALS: 'UNSUPPORTED',
        CONNECTED_ACCOUNTS: 'AVAILABLE',
        CONTACT_COLLECTIVE: 'AVAILABLE',
        CONTACT_FORM: 'AVAILABLE',
        CONVERSATIONS: 'UNSUPPORTED',
        CREATE_COLLECTIVE: 'AVAILABLE',
        EMAIL_NOTIFICATIONS_PANEL: 'AVAILABLE',
        EMIT_GIFT_CARDS: 'AVAILABLE',
        EVENTS: 'UNSUPPORTED',
        HOST_DASHBOARD: 'UNSUPPORTED',
        MULTI_CURRENCY_EXPENSES: 'AVAILABLE',
        OFF_PLATFORM_TRANSACTIONS: 'UNSUPPORTED',
        ORDER: 'AVAILABLE',
        PAYPAL_DONATIONS: 'UNSUPPORTED',
        PAYPAL_PAYOUTS: 'UNSUPPORTED',
        PROJECTS: 'UNSUPPORTED',
        RECEIVE_EXPENSES: 'AVAILABLE',
        RECEIVE_FINANCIAL_CONTRIBUTIONS: 'AVAILABLE',
        RECEIVE_HOST_APPLICATIONS: 'UNSUPPORTED',
        RECURRING_CONTRIBUTIONS: 'UNSUPPORTED',
        REQUEST_VIRTUAL_CARDS: 'AVAILABLE',
        STRIPE_PAYMENT_INTENT: 'DISABLED',
        TEAM: 'AVAILABLE',
        TOP_FINANCIAL_CONTRIBUTORS: 'UNSUPPORTED',
        TRANSACTIONS: 'AVAILABLE',
        TRANSFERWISE: 'UNSUPPORTED',
        UPDATES: 'AVAILABLE',
        USE_EXPENSES: 'AVAILABLE',
        USE_PAYMENT_METHODS: 'AVAILABLE',
        VIRTUAL_CARDS: 'AVAILABLE',
      };

      it('for an active event', async () => {
        const event = await fakeEvent({ isActive: true });
        const featuresMap = getCollectiveFeaturesMap(event);
        expect(featuresMap).to.deep.equal(basePermissions);
      });
    });
  });
});
