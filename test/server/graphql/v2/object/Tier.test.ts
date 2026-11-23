import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeOrder, fakeTier } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const tierOrdersQuery = gql`
  query TierOrders($tierId: Int!, $limit: Int!, $offset: Int!) {
    tier(tier: { legacyId: $tierId }) {
      orders(limit: $limit, offset: $offset) {
        totalCount
        nodes {
          publicId
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Tier', () => {
  before(resetTestDB);

  describe('orders', () => {
    it('returns orders sorted by id, so that pages neither skip nor repeat orders', async () => {
      const tier = await fakeTier();
      const orders = [];
      for (let i = 0; i < 5; i++) {
        orders.push(await fakeOrder({ TierId: tier.id, CollectiveId: tier.CollectiveId }));
      }
      // Updating rows moves them in the table: without a sort, Postgres may return them in another order
      await orders[0].update({ description: 'Updated' });
      await orders[2].update({ description: 'Updated' });

      const ids = [];
      for (const offset of [0, 2, 4]) {
        const result = await graphqlQueryV2(tierOrdersQuery, { tierId: tier.id, limit: 2, offset });
        expect(result.errors).to.not.exist;
        expect(result.data.tier.orders.totalCount).to.equal(5);
        ids.push(...result.data.tier.orders.nodes.map(node => node.publicId));
      }

      expect(ids).to.deep.equal(orders.map(order => order.publicId));
    });
  });
});
