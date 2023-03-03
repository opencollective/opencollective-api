import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeCollective, fakeOrder, fakeTransaction } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const accountQuery = gqlV2/* GraphQL */ `
  query Account($slug: String!, $includeChildren: Boolean!) {
    account(slug: $slug) {
      id
      stats {
        contributionsAmount(includeChildren: $includeChildren) {
          label
          count
          amount {
            value
            valueInCents
            currency
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/AccountStats', () => {
  before(resetTestDB);

  let collective, project;
  beforeEach(async () => {
    collective = await fakeCollective({ type: 'COLLECTIVE' });
    const order1 = await fakeOrder({ CollectiveId: collective.id, amount: 100000 }, { withSubscription: false });
    await fakeTransaction({ CollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 100000, OrderId: order1.id });
    const order2 = await fakeOrder({ CollectiveId: collective.id, amount: 50000 }, { withSubscription: true });
    await fakeTransaction({ CollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 50000, OrderId: order2.id });

    project = await fakeCollective({ ParentCollectiveId: collective.id, type: 'PROJECT' });
    const order3 = await fakeOrder({ CollectiveId: project.id, amount: 10000 }, { withSubscription: false });
    await fakeTransaction({ CollectiveId: project.id, kind: 'CONTRIBUTION', amount: 10000, OrderId: order3.id });
  });

  describe('contributionsAmount', () => {
    it('should return contributionsAmount for recurring vs. one-time donations', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: false });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1000 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });

    it('should include children collective donations', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: true });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1100 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });

    it('should ignore contributions between parent and children collective', async () => {
      await fakeTransaction(
        { CollectiveId: project.id, FromCollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 20000 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { CollectiveId: collective.id, FromCollectiveId: project.id, kind: 'CONTRIBUTION', amount: 30000 },
        { createDoubleEntry: true },
      );

      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: true });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1100 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });
  });
});
