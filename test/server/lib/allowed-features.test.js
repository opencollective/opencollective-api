import { expect } from 'chai';

import FEATURE from '../../../server/constants/feature';
import hasFeature, { isFeatureAllowedForCollectiveType } from '../../../server/lib/allowed-features';
import { fakeCollective } from '../../test-helpers/fake-data';

describe('server/lib/allowed-features', () => {
  describe('isFeatureAllowedForCollectiveType', () => {
    it('CONVERSATIONS', () => {
      expect(isFeatureAllowedForCollectiveType('COLLECTIVE', FEATURE.CONVERSATIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('ORGANIZATION', FEATURE.CONVERSATIONS)).to.be.true;
      expect(isFeatureAllowedForCollectiveType('USER', FEATURE.CONVERSATIONS)).to.be.false;
      expect(isFeatureAllowedForCollectiveType('EVENT', FEATURE.CONVERSATIONS)).to.be.false;
    });
  });

  describe('hasFeature', () => {
    it('Check type', async () => {
      const userCollective = await fakeCollective({ type: 'USER' });
      const collective = await fakeCollective({ type: 'COLLECTIVE' });

      // Conversations
      expect(hasFeature(userCollective, FEATURE.CONVERSATIONS)).to.be.false;
      expect(hasFeature(collective, FEATURE.CONVERSATIONS)).to.be.true;

      // Contact form
      expect(hasFeature(userCollective, FEATURE.CONTACT_FORM)).to.be.false;
      expect(hasFeature(collective, FEATURE.CONTACT_FORM)).to.be.true;
    });

    it('Check opt-out feature flag', async () => {
      const defaultCollective = await fakeCollective();
      const collectiveWithoutContact = await fakeCollective({ settings: { features: { contactForm: false } } });

      expect(hasFeature(collectiveWithoutContact, FEATURE.CONTACT_FORM)).to.be.false;
      expect(hasFeature(defaultCollective, FEATURE.CONTACT_FORM)).to.be.true;
    });
  });
});
