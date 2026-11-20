import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeActiveHost, fakeUser } from '../../../../test-helpers/fake-data';
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
});
