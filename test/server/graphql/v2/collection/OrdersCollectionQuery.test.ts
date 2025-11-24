import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order-status';
import { fakeActiveHost, fakeCollective, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const ordersQuery = gql`
  query Orders($account: AccountReferenceInput, $hostContext: HostContext, $filter: AccountOrdersFilter) {
    orders(account: $account, hostContext: $hostContext, filter: $filter) {
      totalCount
      nodes {
        id
        legacyId
        toAccount {
          id
          legacyId
          slug
        }
        fromAccount {
          id
          legacyId
          slug
        }
      }
    }
  }
`;

describe('server/graphql/v2/collection/OrdersCollectionQuery', () => {
  before(resetTestDB);

  describe('Filter on host context', () => {
    let host,
      hostedCollective,
      contributorUser,
      recipientCollective,
      orderToHost,
      orderToHostedCollective,
      orderFromHost,
      orderFromHostedCollective;

    before(async () => {
      // Create a host account
      host = await fakeActiveHost();

      // Create a hosted collective
      hostedCollective = await fakeCollective({
        HostCollectiveId: host.id,
        approvedAt: new Date(),
      });

      // Create a contributor user
      contributorUser = await fakeUser();

      // Create a recipient collective for outgoing orders
      recipientCollective = await fakeCollective();

      // Create an order to the host account itself (incoming)
      orderToHost = await fakeOrder({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: host.id,
        status: OrderStatuses.PAID,
      });

      // Create an order to the hosted collective (incoming)
      orderToHostedCollective = await fakeOrder({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: hostedCollective.id,
        status: OrderStatuses.PAID,
      });

      // Create an order from the host account (outgoing)
      orderFromHost = await fakeOrder({
        FromCollectiveId: host.id,
        CollectiveId: recipientCollective.id,
        status: OrderStatuses.PAID,
      });

      // Create an order from the hosted collective (outgoing)
      orderFromHostedCollective = await fakeOrder({
        FromCollectiveId: hostedCollective.id,
        CollectiveId: recipientCollective.id,
        status: OrderStatuses.PAID,
      });
    });

    it('ALL - returns orders to both host account and hosted accounts', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(2);

      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIds).to.include(host.id);
      expect(collectiveIds).to.include(hostedCollective.id);
    });

    it('INTERNAL - returns only orders to the host account itself', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(host.id);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderToHost.id);
    });

    it('HOSTED - returns only orders to hosted accounts', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'HOSTED',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(hostedCollective.id);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderToHostedCollective.id);
    });

    it('works with OUTGOING filter', async () => {
      // Test INTERNAL with OUTGOING filter
      const resultInternal = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'OUTGOING',
      });

      expect(resultInternal.errors).to.not.exist;
      expect(resultInternal.data.orders.totalCount).to.eq(1);
      expect(resultInternal.data.orders.nodes[0].fromAccount.legacyId).to.eq(host.id);
      expect(resultInternal.data.orders.nodes[0].legacyId).to.eq(orderFromHost.id);

      // Test HOSTED with OUTGOING filter
      const resultHosted = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'HOSTED',
        filter: 'OUTGOING',
      });

      expect(resultHosted.errors).to.not.exist;
      expect(resultHosted.data.orders.totalCount).to.eq(1);
      expect(resultHosted.data.orders.nodes[0].fromAccount.legacyId).to.eq(hostedCollective.id);
      expect(resultHosted.data.orders.nodes[0].legacyId).to.eq(orderFromHostedCollective.id);

      // Test ALL with OUTGOING filter
      const resultAll = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'OUTGOING',
      });

      expect(resultAll.errors).to.not.exist;
      expect(resultAll.data.orders.totalCount).to.eq(2);
      const fromAccountIds = resultAll.data.orders.nodes.map(node => node.fromAccount.legacyId);
      expect(fromAccountIds).to.include(host.id);
      expect(fromAccountIds).to.include(hostedCollective.id);
    });

    it('works with INCOMING filter', async () => {
      // Test INTERNAL with INCOMING filter
      const resultInternal = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'INCOMING',
      });

      expect(resultInternal.errors).to.not.exist;
      expect(resultInternal.data.orders.totalCount).to.eq(1);
      expect(resultInternal.data.orders.nodes[0].toAccount.legacyId).to.eq(host.id);

      // Test HOSTED with INCOMING filter
      const resultHosted = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'HOSTED',
        filter: 'INCOMING',
      });

      expect(resultHosted.errors).to.not.exist;
      expect(resultHosted.data.orders.totalCount).to.eq(1);
      expect(resultHosted.data.orders.nodes[0].toAccount.legacyId).to.eq(hostedCollective.id);

      // Test ALL with INCOMING filter
      const resultAll = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'INCOMING',
      });

      expect(resultAll.errors).to.not.exist;
      expect(resultAll.data.orders.totalCount).to.eq(2);
    });
  });
});
