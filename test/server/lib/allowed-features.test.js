import { expect } from 'chai';

import FEATURE from '../../../server/constants/feature';
import { hasFeature, isFeatureAllowedForCollectiveType } from '../../../server/lib/allowed-features';
import { fakeCollective } from '../../test-helpers/fake-data';

describe('server/lib/allowed-features', () => {
  describe('isFeatureAllowedForCollectiveType', () => {
    it('RECEIVE_FINANCIAL_CONTRIBUTIONS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS, true)).to.be
        .true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)).to.be.true;
    });
    it('RECURRING_CONTRIBUTIONS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECURRING_CONTRIBUTIONS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.RECURRING_CONTRIBUTIONS)).to.be.false;
    });
    it('EVENTS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.EVENTS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.EVENTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.EVENTS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.EVENTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.EVENTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.EVENTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.EVENTS)).to.be.false;
    });
    it('PROJECTS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.PROJECTS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PROJECTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PROJECTS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.PROJECTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.PROJECTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.PROJECTS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.PROJECTS)).to.be.false;
    });
    it('USE_EXPENSES', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.USE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.USE_EXPENSES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.USE_EXPENSES, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.USE_EXPENSES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.USE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.USE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.USE_EXPENSES)).to.be.true;
    });
    it('RECEIVE_EXPENSES', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.RECEIVE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECEIVE_EXPENSES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.RECEIVE_EXPENSES, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.RECEIVE_EXPENSES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.RECEIVE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.RECEIVE_EXPENSES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.RECEIVE_EXPENSES)).to.be.true;
    });
    it('COLLECTIVE_GOALS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.COLLECTIVE_GOALS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.COLLECTIVE_GOALS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.COLLECTIVE_GOALS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.COLLECTIVE_GOALS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.COLLECTIVE_GOALS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.COLLECTIVE_GOALS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.COLLECTIVE_GOALS)).to.be.true;
    });

    it('TOP_FINANCIAL_CONTRIBUTORS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TOP_FINANCIAL_CONTRIBUTORS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.TOP_FINANCIAL_CONTRIBUTORS)).to.be.false;
    });

    it('UPDATES', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.UPDATES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.UPDATES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.UPDATES, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.UPDATES)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.UPDATES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.UPDATES)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.UPDATES)).to.be.true;
    });
    it('CONVERSATIONS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.CONVERSATIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.CONVERSATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.CONVERSATIONS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.CONVERSATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.CONVERSATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.CONVERSATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.CONVERSATIONS)).to.be.false;
    });
    it('TEAM', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.TEAM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TEAM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TEAM, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.TEAM)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.TEAM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.TEAM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.TEAM)).to.be.true;
    });

    // Other
    it('CONTACT_FORM', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.CONTACT_FORM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.CONTACT_FORM)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.CONTACT_FORM, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.CONTACT_FORM)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.CONTACT_FORM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.CONTACT_FORM)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.CONTACT_FORM)).to.be.true;
    });
    it('TRANSFERWISE', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.TRANSFERWISE)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TRANSFERWISE)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.TRANSFERWISE, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.TRANSFERWISE)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.TRANSFERWISE)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.TRANSFERWISE)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.TRANSFERWISE)).to.be.false;
    });
    it('PAYPAL_PAYOUTS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PAYPAL_PAYOUTS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.PAYPAL_PAYOUTS)).to.be.false;
    });
    it('PAYPAL_DONATIONS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.PAYPAL_DONATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PAYPAL_DONATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.PAYPAL_DONATIONS, true)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.PAYPAL_DONATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.PAYPAL_DONATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('FUND', FEATURE.PAYPAL_DONATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('PROJECT', FEATURE.PAYPAL_DONATIONS)).to.be.false;
    });
  });

  describe('hasFeature', () => {
    it('Check opt-out feature flag for contact form', async () => {
      const defaultCollective = await fakeCollective();
      const collectiveWithoutContact = await fakeCollective({ settings: { features: { contactForm: false } } });

      expect(hasFeature(collectiveWithoutContact, FEATURE.CONTACT_FORM)).to.be.false;
      expect(hasFeature(defaultCollective, FEATURE.CONTACT_FORM)).to.be.true;
    });

    it('Check opt-in feature flag for goals', async () => {
      const defaultCollective = await fakeCollective();
      const collectiveWithGoals = await fakeCollective({ settings: { collectivePage: { showGoals: true } } });

      expect(hasFeature(defaultCollective, FEATURE.COLLECTIVE_GOALS)).to.be.false;
      expect(hasFeature(collectiveWithGoals, FEATURE.COLLECTIVE_GOALS)).to.be.true;
    });
  });
});
