import { expect } from 'chai';
import gql from 'fake-tag';

import POLICIES from '../../../../../server/constants/policies';
import { fakeActiveHost, fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const virtualCardPoliciesQuery = gql`
  query VirtualCardPolicies($slug: String) {
    account(slug: $slug) {
      policies {
        MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL {
          MONTHLY {
            value
            valueInCents
            currency
          }
        }
      }
    }
  }
`;

const contributorInfoThresholdsQuery = gql`
  query ContributorInfoThresholds($slug: String!) {
    account(slug: $slug) {
      policies {
        CONTRIBUTOR_INFO_THRESHOLDS {
          legalName
          address
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Policies', () => {
  before(resetTestDB);

  describe('MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL', () => {
    it('returns the limit as an amount (policy is stored in whole currency units)', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({
        admin,
        currency: 'EUR',
        // `features.virtualCards` is not part of the typed settings
        settings: { features: { virtualCards: true } } as Record<string, unknown>,
        data: { policies: { MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL: { MONTHLY: 1234 } } },
      });

      const result = await graphqlQueryV2(virtualCardPoliciesQuery, { slug: host.slug }, admin);
      expect(result.errors).to.not.exist;
      const monthly = result.data.account.policies.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL.MONTHLY;
      // VirtualCardMutations rejects `limitAmountInCents > 1234 * 100`, so the limit is 1234 EUR
      expect(monthly).to.deep.eq({ value: 1234, valueInCents: 123400, currency: 'EUR' });
    });
  });

  describe('CONTRIBUTOR_INFO_THRESHOLDS', () => {
    // Without a Fixer API key, getFxRate returns 1.1 in the test env
    it('returns the default USD thresholds for a USD host without a policy', async () => {
      const host = await fakeActiveHost({ currency: 'USD', data: {} });
      const result = await graphqlQueryV2(contributorInfoThresholdsQuery, { slug: host.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.policies.CONTRIBUTOR_INFO_THRESHOLDS).to.deep.equal({
        legalName: 25000,
        address: 500000,
      });
    });

    it('converts the default USD thresholds to the collective currency', async () => {
      const host = await fakeActiveHost({ currency: 'USD', data: {} });
      const collective = await fakeCollective({ currency: 'EUR', HostCollectiveId: host.id });
      const result = await graphqlQueryV2(contributorInfoThresholdsQuery, { slug: collective.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.policies.CONTRIBUTOR_INFO_THRESHOLDS).to.deep.equal({
        legalName: 27500,
        address: 550000,
      });
    });

    it('converts the host policy thresholds to the collective currency', async () => {
      const host = await fakeActiveHost({
        currency: 'USD',
        data: { policies: { [POLICIES.CONTRIBUTOR_INFO_THRESHOLDS]: { legalName: 10000, address: 20000 } } },
      });
      const collective = await fakeCollective({ currency: 'EUR', HostCollectiveId: host.id });
      const result = await graphqlQueryV2(contributorInfoThresholdsQuery, { slug: collective.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.policies.CONTRIBUTOR_INFO_THRESHOLDS).to.deep.equal({
        legalName: 11000,
        address: 22000,
      });
    });

    it('returns null for a non-USD host without a policy', async () => {
      const host = await fakeActiveHost({ currency: 'EUR', data: {} });
      const result = await graphqlQueryV2(contributorInfoThresholdsQuery, { slug: host.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.policies.CONTRIBUTOR_INFO_THRESHOLDS).to.be.null;
    });
  });
});
