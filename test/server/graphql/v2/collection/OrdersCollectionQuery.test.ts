import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order-status';
import { fakeActiveHost, fakeCollective, fakeEvent, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const ordersQuery = gql`
  query Orders(
    $account: AccountReferenceInput
    $hostContext: HostContext
    $filter: AccountOrdersFilter
    $includeChildrenAccounts: Boolean
    $hostedAccounts: [AccountReferenceInput]
  ) {
    orders(
      account: $account
      hostContext: $hostContext
      filter: $filter
      includeChildrenAccounts: $includeChildrenAccounts
      hostedAccounts: $hostedAccounts
    ) {
      totalCount
      nodes {
        id
        legacyId
        toAccount {
          id
          legacyId
          slug
          ... on AccountWithHost {
            host {
              legacyId
              id
              name
            }
          }
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
      childAccount,
      contributorUser,
      recipientCollective,
      orderToHost,
      orderToHostedCollective,
      orderToChildAccount,
      orderFromHost,
      orderFromHostedCollective,
      orderFromChildAccount;

    before(async () => {
      // Create a host account
      host = await fakeActiveHost();

      // Create a hosted collective
      hostedCollective = await fakeCollective({
        HostCollectiveId: host.id,
        approvedAt: new Date(),
      });

      // Create a child account (event) under the hosted collective
      childAccount = await fakeEvent({
        ParentCollectiveId: hostedCollective.id,
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

      // Create an order to the child account (incoming)
      orderToChildAccount = await fakeOrder({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: childAccount.id,
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

      // Create an order from the child account (outgoing)
      orderFromChildAccount = await fakeOrder({
        FromCollectiveId: childAccount.id,
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
      // When hostContext is set, children accounts are automatically included
      expect(result.data.orders.totalCount).to.eq(3);

      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIds).to.include(host.id);
      expect(collectiveIds).to.include(hostedCollective.id);
      expect(collectiveIds).to.include(childAccount.id);
    });

    it('INTERNAL - returns only orders to the host account itself, including children', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      // INTERNAL returns only the host account itself, but when hostContext is set, it includes children of the host
      // Since we don't have a child of the host in this test, it should return 1
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
      // When hostContext is set, children accounts are automatically included
      expect(result.data.orders.totalCount).to.eq(2);
      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIds).to.include(hostedCollective.id);
      expect(collectiveIds).to.include(childAccount.id);
      expect(collectiveIds).to.not.include(host.id);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(orderIds).to.include(orderToHostedCollective.id);
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
      // When hostContext is set, children accounts are automatically included
      expect(resultHosted.data.orders.totalCount).to.eq(2);
      const fromAccountIdsHosted = resultHosted.data.orders.nodes.map(node => node.fromAccount.legacyId);
      expect(fromAccountIdsHosted).to.include(hostedCollective.id);
      expect(fromAccountIdsHosted).to.include(childAccount.id);
      expect(fromAccountIdsHosted).to.not.include(host.id);
      const orderIdsHosted = resultHosted.data.orders.nodes.map(node => node.legacyId);
      expect(orderIdsHosted).to.include(orderFromHostedCollective.id);

      // Test ALL with OUTGOING filter
      const resultAll = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'OUTGOING',
      });

      expect(resultAll.errors).to.not.exist;
      // When hostContext is set, children accounts are automatically included
      expect(resultAll.data.orders.totalCount).to.eq(3);
      const fromAccountIds = resultAll.data.orders.nodes.map(node => node.fromAccount.legacyId);
      expect(fromAccountIds).to.include(host.id);
      expect(fromAccountIds).to.include(hostedCollective.id);
      expect(fromAccountIds).to.include(childAccount.id);
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
      // When hostContext is set, children accounts are automatically included
      expect(resultHosted.data.orders.totalCount).to.eq(2);
      const collectiveIdsHosted = resultHosted.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIdsHosted).to.include(hostedCollective.id);
      expect(collectiveIdsHosted).to.include(childAccount.id);

      // Test ALL with INCOMING filter
      const resultAll = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'INCOMING',
      });

      expect(resultAll.errors).to.not.exist;
      // When hostContext is set, children accounts are automatically included
      expect(resultAll.data.orders.totalCount).to.eq(3);
      const collectiveIdsAll = resultAll.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIdsAll).to.include(host.id);
      expect(collectiveIdsAll).to.include(hostedCollective.id);
      expect(collectiveIdsAll).to.include(childAccount.id);
    });

    describe('with children accounts', () => {
      it('without hostContext and includeChildrenAccounts: false - excludes children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: hostedCollective.id },
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });

        expect(result.errors).to.not.exist;
        // When hostContext is not set, includeChildrenAccounts: false should exclude children
        expect(result.data.orders.totalCount).to.eq(1);
        expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(hostedCollective.id);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.not.include(childAccount.id);
      });

      it('without hostContext and includeChildrenAccounts: true - includes children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: hostedCollective.id },
          filter: 'INCOMING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        // When hostContext is not set, includeChildrenAccounts: true should include children
        expect(result.data.orders.totalCount).to.eq(2);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
      });
      it('ALL with hostedAccounts - only returns orders for specified hosted accounts', async () => {
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          hostedAccounts: [{ legacyId: hostedCollective.id }],
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });
        console.log({
          hostSlug: host.slug,
          hostedAccountSlug: hostedCollective.slug,
          nodesLength: results.data.orders.nodes.length,
          totalCount: results.data.orders.totalCount,
        });
        console.log(results.data.orders.nodes);

        expect(results.errors).to.not.exist;
        // Should only include the specified hosted account
        expect(results.data.orders.totalCount).to.eq(1);
        const collectiveIds = results.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.not.include(host.id);
        expect(collectiveIds).to.include(hostedCollective.id);
      });
      it('ALL with hostedAccounts and includeChildrenAccounts - only returns orders for specified hosted accounts with children', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          hostedAccounts: [{ legacyId: hostedCollective.id }],
          filter: 'INCOMING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        // Should only include the specified hosted account and its children, not the host itself
        expect(result.data.orders.totalCount).to.eq(2);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.not.include(host.id);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
      });
      it('INTERNAL with hosted collective in hostedAccounts - should reject', async () => {
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          hostedAccounts: [{ legacyId: hostedCollective.id }],
          filter: 'INCOMING',
        });

        // Should throw a Forbidden error
        expect(results.errors).to.exist;
        expect(results.errors[0].message).to.include(
          'You can only fetch orders from the host account or its children with host context set to INTERNAL',
        );
      });
      it('INTERNAL with host account in hostedAccounts - should return host account orders', async () => {
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          hostedAccounts: [{ legacyId: host.id }],
          filter: 'INCOMING',
        });

        expect(results.errors).to.not.exist;
        // Should include host account order, since host account is part of hostContext is set to INTERNAL
        expect(results.data.orders.totalCount).to.eq(1);
      });
      it('should reject hostedAccounts from other hosts with ALL context', async () => {
        // Create a second host
        const otherHost = await fakeActiveHost();

        // Create a hosted collective for the other host
        const otherHostedCollective = await fakeCollective({
          HostCollectiveId: otherHost.id,
          approvedAt: new Date(),
        });

        // Try to query orders for the first host using the other host's hosted collective
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          hostedAccounts: [{ legacyId: otherHostedCollective.id }],
          filter: 'INCOMING',
        });

        // Should throw a Forbidden error
        expect(results.errors).to.exist;
        expect(results.errors[0].message).to.include(
          'You can only fetch orders from hosted accounts of the specified account',
        );
      });
      it('should reject hostedAccounts from other hosts with INTERNAL context', async () => {
        // Create a second host
        const otherHost = await fakeActiveHost();

        // Create a hosted collective for the other host
        const otherHostedCollective = await fakeCollective({
          HostCollectiveId: otherHost.id,
          approvedAt: new Date(),
        });

        // Try to query orders for the first host using the other host's hosted collective
        // With INTERNAL context, it should throw a Forbidden error since it's not the host itself or a child
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          hostedAccounts: [{ legacyId: otherHostedCollective.id }],
          filter: 'INCOMING',
        });

        // Should throw a Forbidden error
        expect(results.errors).to.exist;
        expect(results.errors[0].message).to.include(
          'You can only fetch orders from hosted accounts of the specified account',
        );
      });
      it('ALL with includeChildrenAccounts: false - still includes children because hostContext overrides it', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });

        expect(result.errors).to.not.exist;
        // When hostContext is set, it automatically includes children accounts, overriding includeChildrenAccounts
        expect(result.data.orders.totalCount).to.eq(3);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.include(host.id);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
      });

      it('ALL with includeChildrenAccounts: true - includes orders to children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          filter: 'INCOMING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.totalCount).to.eq(3);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.include(host.id);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
        const orderIds = result.data.orders.nodes.map(node => node.legacyId);
        expect(orderIds).to.include(orderToChildAccount.id);
      });

      it('INTERNAL with includeChildrenAccounts: false - still includes children of host because hostContext overrides it', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });

        expect(result.errors).to.not.exist;
        // When hostContext is set, it automatically includes children accounts, overriding includeChildrenAccounts
        // Since we don't have a child of the host in this test, it should return 1
        expect(result.data.orders.totalCount).to.eq(1);
        expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(host.id);
      });

      it('INTERNAL with includeChildrenAccounts: true - includes children of host when hostContext is set', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          filter: 'INCOMING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        // INTERNAL returns only the host itself, and when hostContext is set, it includes children of the host
        // Since we don't have a child of the host in this test, it should return 1
        expect(result.data.orders.totalCount).to.eq(1);
        expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(host.id);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.not.include(childAccount.id);
      });

      it('HOSTED with includeChildrenAccounts: false - still includes children because hostContext overrides it', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });

        expect(result.errors).to.not.exist;
        // When hostContext is set, it automatically includes children accounts, overriding includeChildrenAccounts
        expect(result.data.orders.totalCount).to.eq(2);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
        expect(collectiveIds).to.not.include(host.id);
      });

      it('HOSTED with includeChildrenAccounts: true - includes orders to children accounts of hosted collectives', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          filter: 'INCOMING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.totalCount).to.eq(2);
        const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.include(childAccount.id);
        expect(collectiveIds).to.not.include(host.id);
        const orderIds = result.data.orders.nodes.map(node => node.legacyId);
        expect(orderIds).to.include(orderToChildAccount.id);
      });

      it('ALL with includeChildrenAccounts: true and OUTGOING filter - includes orders from children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          filter: 'OUTGOING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.totalCount).to.eq(3);
        const fromAccountIds = result.data.orders.nodes.map(node => node.fromAccount.legacyId);
        expect(fromAccountIds).to.include(host.id);
        expect(fromAccountIds).to.include(hostedCollective.id);
        expect(fromAccountIds).to.include(childAccount.id);
        const orderIds = result.data.orders.nodes.map(node => node.legacyId);
        expect(orderIds).to.include(orderFromChildAccount.id);
      });

      it('HOSTED with includeChildrenAccounts: true and OUTGOING filter - includes orders from children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          filter: 'OUTGOING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.totalCount).to.eq(2);
        const fromAccountIds = result.data.orders.nodes.map(node => node.fromAccount.legacyId);
        expect(fromAccountIds).to.include(hostedCollective.id);
        expect(fromAccountIds).to.include(childAccount.id);
        expect(fromAccountIds).to.not.include(host.id);
        const orderIds = result.data.orders.nodes.map(node => node.legacyId);
        expect(orderIds).to.include(orderFromChildAccount.id);
      });

      it('INTERNAL with includeChildrenAccounts: true and OUTGOING filter - excludes orders from children accounts', async () => {
        const result = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          filter: 'OUTGOING',
          includeChildrenAccounts: true,
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.totalCount).to.eq(1);
        expect(result.data.orders.nodes[0].fromAccount.legacyId).to.eq(host.id);
        const fromAccountIds = result.data.orders.nodes.map(node => node.fromAccount.legacyId);
        expect(fromAccountIds).to.not.include(childAccount.id);
      });
    });
  });
});
