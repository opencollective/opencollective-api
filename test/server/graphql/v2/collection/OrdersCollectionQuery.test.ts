import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order-status';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeOrder,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const ordersQuery = gql`
  query Orders(
    $account: AccountReferenceInput
    $hostContext: HostContext
    $filter: AccountOrdersFilter
    $includeChildrenAccounts: Boolean
    $hostedAccounts: [AccountReferenceInput]
    $includeHostedAccounts: Boolean
    $accountingCategory: [String]
    $createdBy: [AccountReferenceInput]
  ) {
    orders(
      account: $account
      hostContext: $hostContext
      filter: $filter
      includeChildrenAccounts: $includeChildrenAccounts
      hostedAccounts: $hostedAccounts
      includeHostedAccounts: $includeHostedAccounts
      accountingCategory: $accountingCategory
      createdBy: $createdBy
    ) {
      totalCount
      nodes {
        id
        legacyId
        accountingCategory {
          code
        }
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
        createdByAccount {
          id
          legacyId
          slug
        }
      }
    }
  }
`;

const ordersWithCreatedByUsersQuery = gql`
  query OrdersWithCreatedByUsers(
    $account: AccountReferenceInput
    $hostContext: HostContext
    $filter: AccountOrdersFilter
    $includeChildrenAccounts: Boolean
    $expectedFundsFilter: ExpectedFundsFilter
    $status: [OrderStatus]
    $createdByUsersLimit: Int
    $createdByUsersOffset: Int
    $createdByUsersSearchTerm: String
  ) {
    orders(
      account: $account
      hostContext: $hostContext
      filter: $filter
      includeChildrenAccounts: $includeChildrenAccounts
      expectedFundsFilter: $expectedFundsFilter
      status: $status
    ) {
      totalCount
      createdByUsers(
        limit: $createdByUsersLimit
        offset: $createdByUsersOffset
        searchTerm: $createdByUsersSearchTerm
      ) {
        totalCount
        limit
        offset
        nodes {
          id
          legacyId
          slug
          name
        }
      }
    }
  }
`;

describe('server/graphql/v2/collection/OrdersCollectionQuery', () => {
  before(resetTestDB);

  describe('hostContext filter', () => {
    let host,
      hostChild,
      hostedCollective,
      childAccount,
      contributorUser,
      recipientCollective,
      orderToHost,
      orderToHostChild,
      orderToHostedCollective,
      orderFromHost,
      orderFromHostChild,
      orderFromHostedCollective;

    before(async () => {
      // Create a host account
      host = await fakeActiveHost();

      // Create a child account (event) directly under the host
      hostChild = await fakeEvent({
        ParentCollectiveId: host.id,
        approvedAt: new Date(),
        name: 'Host child',
      });

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

      // Create an order to the host child account (incoming)
      orderToHostChild = await fakeOrder({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: hostChild.id,
        status: OrderStatuses.PAID,
      });

      // Create an order to the hosted collective (incoming)
      orderToHostedCollective = await fakeOrder({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: hostedCollective.id,
        status: OrderStatuses.PAID,
      });

      // Create an order to the child account (incoming)
      await fakeOrder({
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

      // Create an order from the host child account (outgoing)
      orderFromHostChild = await fakeOrder({
        FromCollectiveId: hostChild.id,
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
      await fakeOrder({
        FromCollectiveId: childAccount.id,
        CollectiveId: recipientCollective.id,
        status: OrderStatuses.PAID,
      });
    });

    it('should return orders to host account, hosted accounts, and their children when hostContext is ALL', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'ALL',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      // When hostContext is set, children accounts are automatically included
      expect(result.data.orders.totalCount).to.eq(4);

      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIds).to.include(host.id);
      expect(collectiveIds).to.include(hostChild.id);
      expect(collectiveIds).to.include(hostedCollective.id);
      expect(collectiveIds).to.include(childAccount.id);
    });

    it('should return only orders to the host account and its children when hostContext is INTERNAL', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      // INTERNAL returns only the host account itself, but when hostContext is set, it includes children of the host
      // Since we have a child of the host (hostChild), it should return 2
      expect(result.data.orders.totalCount).to.eq(2);
      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIds).to.include(host.id);
      expect(collectiveIds).to.include(hostChild.id);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(orderIds).to.include(orderToHost.id);
      expect(orderIds).to.include(orderToHostChild.id);
    });

    it('should return only orders to hosted accounts and their children when hostContext is HOSTED', async () => {
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

    it('should work correctly with OUTGOING filter for all hostContext values', async () => {
      // Test INTERNAL with OUTGOING filter
      const resultInternal = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'OUTGOING',
      });

      expect(resultInternal.errors).to.not.exist;
      expect(resultInternal.data.orders.totalCount).to.eq(2);
      const fromAccountIdsInternal = resultInternal.data.orders.nodes.map(node => node.fromAccount.legacyId);
      expect(fromAccountIdsInternal).to.include(host.id);
      expect(fromAccountIdsInternal).to.include(hostChild.id);
      const orderIdsInternal = resultInternal.data.orders.nodes.map(node => node.legacyId);
      expect(orderIdsInternal).to.include(orderFromHost.id);
      expect(orderIdsInternal).to.include(orderFromHostChild.id);

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
      expect(resultAll.data.orders.totalCount).to.eq(4);
      const fromAccountIds = resultAll.data.orders.nodes.map(node => node.fromAccount.legacyId);
      expect(fromAccountIds).to.include(host.id);
      expect(fromAccountIds).to.include(hostChild.id);
      expect(fromAccountIds).to.include(hostedCollective.id);
      expect(fromAccountIds).to.include(childAccount.id);
    });

    it('should work correctly with INCOMING filter for all hostContext values', async () => {
      // Test INTERNAL with INCOMING filter
      const resultInternal = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        hostContext: 'INTERNAL',
        filter: 'INCOMING',
      });

      expect(resultInternal.errors).to.not.exist;
      expect(resultInternal.data.orders.totalCount).to.eq(2);
      const collectiveIdsInternal = resultInternal.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIdsInternal).to.include(host.id);
      expect(collectiveIdsInternal).to.include(hostChild.id);

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
      expect(resultAll.data.orders.totalCount).to.eq(4);
      const collectiveIdsAll = resultAll.data.orders.nodes.map(node => node.toAccount.legacyId);
      expect(collectiveIdsAll).to.include(host.id);
      expect(collectiveIdsAll).to.include(hostChild.id);
      expect(collectiveIdsAll).to.include(hostedCollective.id);
      expect(collectiveIdsAll).to.include(childAccount.id);
    });

    describe('with hostedAccounts and includeChildrenAccounts parameters', () => {
      it('should exclude children accounts when hostContext is not set and includeChildrenAccounts is false', async () => {
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

      it('should include children accounts when hostContext is not set and includeChildrenAccounts is true', async () => {
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
      it('should return only orders for specified hosted accounts when hostContext is ALL and hostedAccounts is provided', async () => {
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          hostedAccounts: [{ legacyId: hostedCollective.id }],
          filter: 'INCOMING',
          includeChildrenAccounts: false,
        });

        expect(results.errors).to.not.exist;
        // Should only include the specified hosted account
        expect(results.data.orders.totalCount).to.eq(1);
        const collectiveIds = results.data.orders.nodes.map(node => node.toAccount.legacyId);
        expect(collectiveIds).to.not.include(host.id);
        expect(collectiveIds).to.include(hostedCollective.id);
      });
      it('should return orders for specified hosted accounts and their children when hostContext is ALL, hostedAccounts is provided, and includeChildrenAccounts is true', async () => {
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
      it('should reject hostedAccounts containing hosted collectives when hostContext is INTERNAL', async () => {
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
      it('should return host account orders when hostContext is INTERNAL and host account is in hostedAccounts', async () => {
        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          hostedAccounts: [{ legacyId: host.id }],
          filter: 'INCOMING',
        });

        expect(results.errors).to.not.exist;
        // Should include host account order and its children, since hostContext is set to INTERNAL
        expect(results.data.orders.totalCount).to.eq(2);
      });

      it('should respect hostedAccounts filtering when hostContext is HOSTED', async () => {
        const extraHostedCollective = await fakeCollective({
          HostCollectiveId: host.id,
          approvedAt: new Date(),
        });
        const extraHostedOrder = await fakeOrder({
          FromCollectiveId: contributorUser.CollectiveId,
          CollectiveId: extraHostedCollective.id,
          status: OrderStatuses.PAID,
        });

        const results = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          hostedAccounts: [{ legacyId: hostedCollective.id }],
          filter: 'INCOMING',
        });

        expect(results.errors).to.not.exist;
        // Should only return orders for the requested hosted account
        expect(results.data.orders.totalCount).to.eq(1);
        const collectiveIds = results.data.orders.nodes.map(node => node.toAccount.legacyId);
        const orderIds = results.data.orders.nodes.map(node => node.legacyId);
        expect(collectiveIds).to.include(hostedCollective.id);
        expect(collectiveIds).to.not.include(extraHostedCollective.id);
        expect(collectiveIds).to.not.include(host.id);
        expect(orderIds).to.include(orderToHostedCollective.id);

        await extraHostedOrder.destroy();
        await extraHostedCollective.destroy();
      });
      it('should reject hostedAccounts from other hosts', async () => {
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

      it('should silently ignore includeChildrenAccounts when hostContext is set without hostedAccounts', async () => {
        // Test with ALL context - includeChildrenAccounts: true should be ignored
        const resultAll = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          filter: 'INCOMING',
          includeChildrenAccounts: true, // This will be ignored, children are included anyway
        });
        expect(resultAll.errors).to.not.exist;
        expect(resultAll.data.orders.totalCount).to.eq(4); // Children are included regardless

        // Test with HOSTED context
        const resultHosted = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          filter: 'INCOMING',
          includeChildrenAccounts: true, // This will be ignored
        });
        expect(resultHosted.errors).to.not.exist;
        expect(resultHosted.data.orders.totalCount).to.eq(2); // Children are included regardless

        // Test with INTERNAL context
        const resultInternal = await graphqlQueryV2(ordersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          filter: 'INCOMING',
          includeChildrenAccounts: true, // This will be ignored
        });
        expect(resultInternal.errors).to.not.exist;
        expect(resultInternal.data.orders.totalCount).to.eq(2); // Host account and its child
      });
    });
  });

  describe('includeHostedAccounts (deprecated argument, without hostContext)', () => {
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

    it('should return only orders to the host account when includeHostedAccounts is false (default) with INCOMING filter', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        filter: 'INCOMING',
        includeHostedAccounts: false,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].toAccount.legacyId).to.eq(host.id);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderToHost.id);
    });

    it('should return only orders from the host account when includeHostedAccounts is false (default) with OUTGOING filter', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        filter: 'OUTGOING',
        includeHostedAccounts: false,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].fromAccount.legacyId).to.eq(host.id);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderFromHost.id);
    });

    it('should return orders to host and hosted accounts when includeHostedAccounts is true with INCOMING filter', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        filter: 'INCOMING',
        includeHostedAccounts: true,
      });

      expect(result.errors).to.not.exist;
      // When includeHostedAccounts is true, children accounts are automatically included
      expect(result.data.orders.totalCount).to.eq(3);
      const collectiveIds = result.data.orders.nodes.map(node => node.toAccount.legacyId);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(collectiveIds).to.include(host.id);
      expect(collectiveIds).to.include(hostedCollective.id);
      expect(collectiveIds).to.include(childAccount.id);
      expect(orderIds).to.include(orderToHost.id);
      expect(orderIds).to.include(orderToHostedCollective.id);
      expect(orderIds).to.include(orderToChildAccount.id);
    });

    it('should return orders from host and hosted accounts when includeHostedAccounts is true with OUTGOING filter', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        filter: 'OUTGOING',
        includeHostedAccounts: true,
      });

      expect(result.errors).to.not.exist;
      // When includeHostedAccounts is true, children accounts are automatically included
      expect(result.data.orders.totalCount).to.eq(3);
      const fromAccountIds = result.data.orders.nodes.map(node => node.fromAccount.legacyId);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(fromAccountIds).to.include(host.id);
      expect(fromAccountIds).to.include(hostedCollective.id);
      expect(fromAccountIds).to.include(childAccount.id);
      expect(orderIds).to.include(orderFromHost.id);
      expect(orderIds).to.include(orderFromHostedCollective.id);
      expect(orderIds).to.include(orderFromChildAccount.id);
    });

    it('should work correctly without filter (both INCOMING and OUTGOING) when includeHostedAccounts is true', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: host.id },
        includeHostedAccounts: true,
        includeChildrenAccounts: false,
      });

      expect(result.errors).to.not.exist;
      // When includeHostedAccounts is true, children accounts are automatically included
      // 3 incoming (host + hosted + child) + 3 outgoing (host + hosted + child) = 6
      expect(result.data.orders.totalCount).to.eq(6);
      const toAccountIds = result.data.orders.nodes.filter(node => node.toAccount).map(node => node.toAccount.legacyId);
      const fromAccountIds = result.data.orders.nodes
        .filter(node => node.fromAccount)
        .map(node => node.fromAccount.legacyId);
      expect(toAccountIds).to.include(host.id);
      expect(toAccountIds).to.include(hostedCollective.id);
      expect(toAccountIds).to.include(childAccount.id);
      expect(fromAccountIds).to.include(host.id);
      expect(fromAccountIds).to.include(hostedCollective.id);
      expect(fromAccountIds).to.include(childAccount.id);
    });
  });

  describe('accountingCategory filter', () => {
    let collective, category1, category2, orderWithCategory1, orderWithCategory2, orderWithoutCategory;

    before(async () => {
      collective = await fakeCollective();

      // Create accounting categories
      category1 = await fakeAccountingCategory({
        CollectiveId: collective.host.id,
        code: 'CATEGORY-001',
        kind: 'CONTRIBUTION',
      });

      category2 = await fakeAccountingCategory({
        CollectiveId: collective.host.id,
        code: 'CATEGORY-002',
        kind: 'CONTRIBUTION',
      });

      // Create orders with different accounting categories
      orderWithCategory1 = await fakeOrder({
        CollectiveId: collective.id,
        status: OrderStatuses.PAID,
        AccountingCategoryId: category1.id,
      });

      orderWithCategory2 = await fakeOrder({
        CollectiveId: collective.id,
        status: OrderStatuses.PAID,
        AccountingCategoryId: category2.id,
      });

      // Create an order without an accounting category
      orderWithoutCategory = await fakeOrder({
        CollectiveId: collective.id,
        status: OrderStatuses.PAID,
        AccountingCategoryId: null,
      });
    });

    it('should return only orders with requested categories', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        accountingCategory: [category1.code],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderWithCategory1.id);
      expect(result.data.orders.nodes[0].accountingCategory.code).to.eq(category1.code);
    });

    it('should return orders matching multiple categories when multiple codes are provided', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        accountingCategory: [category1.code, category2.code],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(2);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(orderIds).to.include(orderWithCategory1.id);
      expect(orderIds).to.include(orderWithCategory2.id);
      expect(orderIds).to.not.include(orderWithoutCategory.id);
    });

    it('should return only orders without a category when passing __uncategorized__', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        accountingCategory: ['__uncategorized__'],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderWithoutCategory.id);
      expect(result.data.orders.nodes[0].accountingCategory).to.be.null;
    });

    it('should return orders with category and uncategorized when both are requested', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        accountingCategory: [category1.code, '__uncategorized__'],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(2);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(orderIds).to.include(orderWithCategory1.id);
      expect(orderIds).to.include(orderWithoutCategory.id);
      expect(orderIds).to.not.include(orderWithCategory2.id);
    });
  });

  describe('createdBy argument', () => {
    let collective, user1, user2, user3, orderByUser1, orderByUser2, orderByUser3;

    before(async () => {
      collective = await fakeCollective();

      // Create users
      user1 = await fakeUser();
      user2 = await fakeUser();
      user3 = await fakeUser();

      // Create orders by different users
      orderByUser1 = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user1.CollectiveId,
        CreatedByUserId: user1.id,
        status: OrderStatuses.PAID,
      });

      orderByUser2 = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user2.CollectiveId,
        CreatedByUserId: user2.id,
        status: OrderStatuses.PAID,
      });

      orderByUser3 = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user3.CollectiveId,
        CreatedByUserId: user3.id,
        status: OrderStatuses.PAID,
      });
    });

    it('should return only orders created by a single specified user', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdBy: [{ legacyId: user1.CollectiveId }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(1);
      expect(result.data.orders.nodes[0].legacyId).to.eq(orderByUser1.id);
      expect(result.data.orders.nodes[0].createdByAccount.legacyId).to.eq(user1.CollectiveId);
    });

    it('should return orders created by multiple specified users', async () => {
      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdBy: [{ legacyId: user1.CollectiveId }, { legacyId: user2.CollectiveId }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(2);
      const orderIds = result.data.orders.nodes.map(node => node.legacyId);
      expect(orderIds).to.include(orderByUser1.id);
      expect(orderIds).to.include(orderByUser2.id);
      expect(orderIds).to.not.include(orderByUser3.id);
    });

    it('should return empty results when no orders match the specified users', async () => {
      const otherUser = await fakeUser();

      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdBy: [{ legacyId: otherUser.CollectiveId }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.totalCount).to.eq(0);
      expect(result.data.orders.nodes).to.be.empty;
    });

    it('should throw an error when no users are found for the specified accounts', async () => {
      const collectiveWithoutUser = await fakeCollective();

      const result = await graphqlQueryV2(ordersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdBy: [{ legacyId: collectiveWithoutUser.id }],
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('No users found for the specified createdBy accounts');
    });
  });

  describe('createdByUsers resolver', () => {
    let collective, childAccount, user1, user2, user3;

    before(async () => {
      collective = await fakeCollective();

      // Create a child account (event) under the collective
      childAccount = await fakeEvent({
        ParentCollectiveId: collective.id,
        approvedAt: new Date(),
      });

      // Create users with specific names for search testing
      user1 = await fakeUser(null, { name: 'Alice Anderson' });
      user2 = await fakeUser(null, { name: 'Bob Builder' });
      user3 = await fakeUser(null, { name: 'Charlie Charlie' });

      // Create orders by different users
      await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user1.CollectiveId,
        CreatedByUserId: user1.id,
        status: OrderStatuses.PAID,
      });

      await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user2.CollectiveId,
        CreatedByUserId: user2.id,
        status: OrderStatuses.PAID,
      });

      // Create order to child account
      await fakeOrder({
        CollectiveId: childAccount.id,
        FromCollectiveId: user3.CollectiveId,
        CreatedByUserId: user3.id,
        status: OrderStatuses.PAID,
      });
    });

    it('should return all users who created orders for INCOMING filter', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(2);
      const userCollectiveIds = result.data.orders.createdByUsers.nodes.map(node => node.legacyId);
      expect(userCollectiveIds).to.include(user1.CollectiveId);
      expect(userCollectiveIds).to.include(user2.CollectiveId);
      expect(userCollectiveIds).to.not.include(user3.CollectiveId); // Created order to child, not directly to collective
    });

    it('should include children accounts when includeChildrenAccounts is true', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        includeChildrenAccounts: true,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(3);
      const userCollectiveIds = result.data.orders.createdByUsers.nodes.map(node => node.legacyId);
      expect(userCollectiveIds).to.include(user1.CollectiveId);
      expect(userCollectiveIds).to.include(user2.CollectiveId);
      expect(userCollectiveIds).to.include(user3.CollectiveId);
    });

    it('should throw error when filter is not provided', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'The `filter` argument (INCOMING or OUTGOING) is required when querying createdByUsers',
      );
    });

    it('should throw error when account is not provided', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        filter: 'INCOMING',
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'The `account` argument (or using `account.orders`) is required when querying createdByUsers',
      );
    });

    it('should support pagination with limit and offset', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdByUsersLimit: 1,
        createdByUsersOffset: 0,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(2);
      expect(result.data.orders.createdByUsers.nodes.length).to.eq(1);
      expect(result.data.orders.createdByUsers.limit).to.eq(1);
      expect(result.data.orders.createdByUsers.offset).to.eq(0);

      // Test offset
      const resultWithOffset = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdByUsersLimit: 1,
        createdByUsersOffset: 1,
      });

      expect(resultWithOffset.errors).to.not.exist;
      expect(resultWithOffset.data.orders.createdByUsers.totalCount).to.eq(2);
      expect(resultWithOffset.data.orders.createdByUsers.nodes.length).to.eq(1);
      expect(resultWithOffset.data.orders.createdByUsers.offset).to.eq(1);
    });

    it('should support search by name', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdByUsersSearchTerm: 'Alice',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(1);
      expect(result.data.orders.createdByUsers.nodes[0].name).to.eq('Alice Anderson');
    });

    it('should support search by slug', async () => {
      const userCollective = await user1.getCollective();

      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdByUsersSearchTerm: userCollective.slug,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(1);
      expect(result.data.orders.createdByUsers.nodes[0].legacyId).to.eq(user1.CollectiveId);
    });

    it('should return empty results when search term does not match', async () => {
      const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
        account: { legacyId: collective.id },
        filter: 'INCOMING',
        createdByUsersSearchTerm: 'NonExistentName',
      });

      expect(result.errors).to.not.exist;
      expect(result.data.orders.createdByUsers.totalCount).to.eq(0);
      expect(result.data.orders.createdByUsers.nodes).to.be.empty;
    });

    describe('with hostContext', () => {
      let host, hostedCollective, hostUser, hostedUser;

      before(async () => {
        host = await fakeActiveHost();

        hostedCollective = await fakeCollective({
          HostCollectiveId: host.id,
          approvedAt: new Date(),
        });

        hostUser = await fakeUser(null, { name: 'Host User' });
        hostedUser = await fakeUser(null, { name: 'Hosted User' });

        // Create order to host
        await fakeOrder({
          CollectiveId: host.id,
          FromCollectiveId: hostUser.CollectiveId,
          CreatedByUserId: hostUser.id,
          status: OrderStatuses.PAID,
        });

        // Create order to hosted collective
        await fakeOrder({
          CollectiveId: hostedCollective.id,
          FromCollectiveId: hostedUser.CollectiveId,
          CreatedByUserId: hostedUser.id,
          status: OrderStatuses.PAID,
        });
      });

      it('should return users from both host and hosted accounts when hostContext is ALL', async () => {
        const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: host.id },
          hostContext: 'ALL',
          filter: 'INCOMING',
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.createdByUsers.totalCount).to.eq(2);
        const userCollectiveIds = result.data.orders.createdByUsers.nodes.map(node => node.legacyId);
        expect(userCollectiveIds).to.include(hostUser.CollectiveId);
        expect(userCollectiveIds).to.include(hostedUser.CollectiveId);
      });

      it('should return only host account users when hostContext is INTERNAL', async () => {
        const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: host.id },
          hostContext: 'INTERNAL',
          filter: 'INCOMING',
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.createdByUsers.totalCount).to.eq(1);
        expect(result.data.orders.createdByUsers.nodes[0].legacyId).to.eq(hostUser.CollectiveId);
      });

      it('should return only hosted account users when hostContext is HOSTED', async () => {
        const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: host.id },
          hostContext: 'HOSTED',
          filter: 'INCOMING',
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.createdByUsers.totalCount).to.eq(1);
        expect(result.data.orders.createdByUsers.nodes[0].legacyId).to.eq(hostedUser.CollectiveId);
      });
    });

    describe('with status filter', () => {
      let collective2, userPaid, userActive;

      before(async () => {
        collective2 = await fakeCollective();

        userPaid = await fakeUser(null, { name: 'Paid User' });
        userActive = await fakeUser(null, { name: 'Active User' });

        // Create paid order
        await fakeOrder({
          CollectiveId: collective2.id,
          FromCollectiveId: userPaid.CollectiveId,
          CreatedByUserId: userPaid.id,
          status: OrderStatuses.PAID,
        });

        // Create active order
        await fakeOrder({
          CollectiveId: collective2.id,
          FromCollectiveId: userActive.CollectiveId,
          CreatedByUserId: userActive.id,
          status: OrderStatuses.ACTIVE,
        });
      });

      it('should respect status filter', async () => {
        const resultPaid = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: collective2.id },
          filter: 'INCOMING',
          status: ['PAID'],
        });

        expect(resultPaid.errors).to.not.exist;
        expect(resultPaid.data.orders.createdByUsers.totalCount).to.eq(1);
        expect(resultPaid.data.orders.createdByUsers.nodes[0].legacyId).to.eq(userPaid.CollectiveId);

        const resultActive = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: collective2.id },
          filter: 'INCOMING',
          status: ['ACTIVE'],
        });

        expect(resultActive.errors).to.not.exist;
        expect(resultActive.data.orders.createdByUsers.totalCount).to.eq(1);
        expect(resultActive.data.orders.createdByUsers.nodes[0].legacyId).to.eq(userActive.CollectiveId);
      });
    });

    describe('with OUTGOING filter', () => {
      let fromCollective, recipient1, recipient2, outgoingUser1, outgoingUser2;

      before(async () => {
        fromCollective = await fakeCollective();
        recipient1 = await fakeCollective();
        recipient2 = await fakeCollective();

        outgoingUser1 = await fakeUser(null, { name: 'Outgoing User 1' });
        outgoingUser2 = await fakeUser(null, { name: 'Outgoing User 2' });

        // Create outgoing orders from the collective
        await fakeOrder({
          CollectiveId: recipient1.id,
          FromCollectiveId: fromCollective.id,
          CreatedByUserId: outgoingUser1.id,
          status: OrderStatuses.PAID,
        });

        await fakeOrder({
          CollectiveId: recipient2.id,
          FromCollectiveId: fromCollective.id,
          CreatedByUserId: outgoingUser2.id,
          status: OrderStatuses.PAID,
        });
      });

      it('should return users who created outgoing orders', async () => {
        const result = await graphqlQueryV2(ordersWithCreatedByUsersQuery, {
          account: { legacyId: fromCollective.id },
          filter: 'OUTGOING',
        });

        expect(result.errors).to.not.exist;
        expect(result.data.orders.createdByUsers.totalCount).to.eq(2);
        const userCollectiveIds = result.data.orders.createdByUsers.nodes.map(node => node.legacyId);
        expect(userCollectiveIds).to.include(outgoingUser1.CollectiveId);
        expect(userCollectiveIds).to.include(outgoingUser2.CollectiveId);
      });
    });
  });
});
