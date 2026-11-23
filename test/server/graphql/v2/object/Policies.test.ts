import { expect } from 'chai';
import gql from 'fake-tag';

import POLICIES from '../../../../../server/constants/policies';
import { fakeActiveHost, fakeCollective } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

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
