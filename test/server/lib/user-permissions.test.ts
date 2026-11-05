import { expect } from 'chai';

import FEATURE from '../../../server/constants/feature';
import { canUseFeature } from '../../../server/lib/user-permissions';

type FeatureAccount = Parameters<typeof canUseFeature>[0];
type FeatureAccountData = { id: number; data?: { features?: Record<string, boolean> } };

/** `canUseFeature` only reads `data.features`, so these fixtures don't need to be full models. */
const mockAccount = (account: FeatureAccountData): FeatureAccount => account as FeatureAccount;

/**
 * `COMMENTS` is no longer part of the FEATURE enum. Keeping the literal preserves the
 * original runtime behavior of these tests (an unknown feature key).
 */
const COMMENTS_FEATURE = 'COMMENTS' as FEATURE;

const validUserData: FeatureAccountData = {
  id: 1,
};

const validUser = mockAccount(validUserData);

const limitedUser = mockAccount({
  id: 2,
  data: {
    features: {
      ALL: false,
    },
  },
});

describe('server/lib/user-permissions', () => {
  describe('canUseFeature', () => {
    it('always returns false for null users', () => {
      expect(canUseFeature(null, undefined)).to.eq(false);
      expect(canUseFeature(null, COMMENTS_FEATURE)).to.eq(false);
      expect(canUseFeature(undefined, COMMENTS_FEATURE)).to.eq(false);
    });

    it('always returns false for limited users', () => {
      expect(canUseFeature(limitedUser, COMMENTS_FEATURE)).to.eq(false);
      expect(canUseFeature(limitedUser, FEATURE.ORDER)).to.eq(false);
      expect(canUseFeature(limitedUser, FEATURE.CONVERSATIONS)).to.eq(false);
    });

    it('returns true if user can use the feature', () => {
      expect(canUseFeature(validUser, COMMENTS_FEATURE)).to.eq(true);
      expect(canUseFeature(validUser, FEATURE.ORDER)).to.eq(true);
      expect(canUseFeature(validUser, FEATURE.CONVERSATIONS)).to.eq(true);
    });

    it('returns false if user cannot use the feature', () => {
      expect(
        canUseFeature(
          mockAccount({ ...validUserData, data: { features: { [COMMENTS_FEATURE]: false } } }),
          COMMENTS_FEATURE,
        ),
      ).to.eq(false);

      expect(
        canUseFeature(
          mockAccount({ ...validUserData, data: { features: { [COMMENTS_FEATURE]: false } } }),
          FEATURE.ORDER,
        ),
      ).to.eq(true);

      expect(
        canUseFeature(mockAccount({ ...validUserData, data: { features: { [FEATURE.ORDER]: false } } }), FEATURE.ORDER),
      ).to.eq(false);
    });
  });
});
