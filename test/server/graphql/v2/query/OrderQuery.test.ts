import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeActivity, fakeCollective, fakeHost, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/query/ExpenseQuery', () => {
  before(resetTestDB);

  let order, ownerUser, collectiveAdminUser, hostAdminUser, randomUser;

  const orderQuery = gql`
    query Order($legacyId: Int!) {
      order(order: { legacyId: $legacyId }) {
        id
        customData
        activities {
          totalCount
          nodes {
            id
            type
          }
        }
      }
    }
  `;

  before(async () => {
    ownerUser = await fakeUser({}, { legalName: 'A Legal Name' });
    hostAdminUser = await fakeUser();
    collectiveAdminUser = await fakeUser();
    randomUser = await fakeUser();

    const host = await fakeHost({ admin: hostAdminUser });
    const collective = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id });
    order = await fakeOrder({
      FromCollectiveId: ownerUser.CollectiveId,
      CollectiveId: collective.id,
      data: {
        customData: {
          hello: 'world',
        },
      },
    });

    await fakeActivity({ OrderId: order.id, type: 'order.pending' });
    await fakeActivity({ OrderId: order.id, type: 'order.confirmed' });
    await fakeActivity({ OrderId: order.id, type: 'orders.suspicious' });
  });

  const fetchOrder = (legacyId, remoteUser = undefined) => {
    return graphqlQueryV2(orderQuery, { legacyId }, remoteUser).then(result => result.data.order);
  };

  describe('Permissions', () => {
    describe('data', () => {
      describe('customData', () => {
        it('can only be fetched by admins', async () => {
          const fetchedOrderUnauthenticated = await fetchOrder(order.id);
          const fetchedOrderRandomUser = await fetchOrder(order.id, randomUser);
          const fetchedOrderOwner = await fetchOrder(order.id, ownerUser);
          const fetchedOrderCollectiveAdmin = await fetchOrder(order.id, collectiveAdminUser);
          const fetchedOrderHostAdmin = await fetchOrder(order.id, hostAdminUser);

          // Only collective admin + owner can fetch custom data
          expect(fetchedOrderOwner.customData).to.deep.eq(order.data.customData);
          expect(fetchedOrderCollectiveAdmin.customData).to.deep.eq(order.data.customData);

          // Others can't
          expect(fetchedOrderUnauthenticated.customData).to.be.null;
          expect(fetchedOrderRandomUser.customData).to.be.null;
          expect(fetchedOrderHostAdmin.customData).to.be.null;
        });
      });
    });
  });

  describe('activities', () => {
    it('returns public activities in most cases', async () => {
      for (const user of [undefined, ownerUser, collectiveAdminUser, randomUser]) {
        const fetchedOrder = await fetchOrder(order.id, user);
        expect(fetchedOrder.activities.totalCount).to.eq(2);
        expect(fetchedOrder.activities.nodes[0].type).to.eq('ORDER_PENDING');
        expect(fetchedOrder.activities.nodes[1].type).to.eq('ORDER_CONFIRMED');
      }
    });

    it('returns private activities to admins', async () => {
      const fetchedOrder = await fetchOrder(order.id, hostAdminUser);
      expect(fetchedOrder.activities.totalCount).to.eq(3);
      expect(fetchedOrder.activities.nodes[0].type).to.eq('ORDER_PENDING');
      expect(fetchedOrder.activities.nodes[1].type).to.eq('ORDER_CONFIRMED');
      expect(fetchedOrder.activities.nodes[2].type).to.eq('ORDERS_SUSPICIOUS');
    });
  });
});
