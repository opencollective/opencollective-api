import { expect } from 'chai';

import {
  platformSubscriptionFeaturesByTierType,
  PlatformSubscriptionTiers,
  PlatformSubscriptionTierTypes,
} from '../../../server/constants/plans';

describe('server/constants/plans PlatformSubscriptionTiers', () => {
  const idPrefixByType: Record<PlatformSubscriptionTierTypes, string> = {
    [PlatformSubscriptionTierTypes.FREE]: 'discover',
    [PlatformSubscriptionTierTypes.BASIC]: 'basic',
    [PlatformSubscriptionTierTypes.PRO]: 'pro',
  };

  it('has unique tier ids', () => {
    const ids = PlatformSubscriptionTiers.map(t => t.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('sets features from the canonical map for each tier type', () => {
    for (const tier of PlatformSubscriptionTiers) {
      expect(tier.features).to.deep.equal(platformSubscriptionFeaturesByTierType[tier.type]);
    }
  });

  it('uses standard id and title patterns that match the tier type', () => {
    for (const tier of PlatformSubscriptionTiers) {
      const idPrefix = idPrefixByType[tier.type];
      expect(tier.id, `id ${tier.id}`).to.match(new RegExp(`^${idPrefix}-\\d+$`));
      expect(tier.title, `title ${tier.title}`).to.match(new RegExp(`^${tier.type} \\d+$`));
    }
  });
});
