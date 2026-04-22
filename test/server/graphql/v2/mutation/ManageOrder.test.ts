import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import OrderStatuses from '../../../../../server/constants/order-status';
import { RefundKind } from '../../../../../server/constants/refund-kind';
import roles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import * as TransactionMutationHelpers from '../../../../../server/graphql/common/transactions';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const MANAGE_ORDER_MUTATION = gql`
  mutation ManageOrder($order: OrderReferenceInput!, $action: ManageOrderInput!) {
    manageOrder(order: $order, action: $action) {
      order {
        id
        legacyId
        status
      }
      refundedTransactions {
        id
        legacyId
      }
      refundErrors {
        message
        code
        transaction {
          id
          legacyId
        }
      }
    }
  }
`;

const ORDER_PERMISSIONS_QUERY = gql`
  query OrderPermissions($id: String!) {
    order(order: { id: $id }) {
      id
      permissions {
        canHostCancel
        canHostRefund
        canHostRemoveAsContributor
      }
    }
  }
`;

// Helper: build a collective hosted by an active host, a contributor, an
// active recurring order with a Subscription, and a refundable CREDIT
// CONTRIBUTION transaction attached to that order.
const setupOrderScenario = async () => {
  const host = await fakeActiveHost();
  const hostAdmin = await fakeUser();
  await host.addUserWithRole(hostAdmin, roles.ADMIN);
  await hostAdmin.populateRoles();

  const collective = await fakeCollective({ HostCollectiveId: host.id });
  const collectiveAdmin = await fakeUser();
  await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
  await collectiveAdmin.populateRoles();

  const contributor = await fakeUser();
  const paymentMethod = await fakePaymentMethod({
    service: 'stripe',
    type: 'creditcard',
    CollectiveId: contributor.CollectiveId,
  });

  const order = await fakeOrder(
    {
      CreatedByUserId: contributor.id,
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      PaymentMethodId: paymentMethod.id,
      status: OrderStatuses.ACTIVE,
      totalAmount: 10000,
      currency: 'USD',
    },
    { withSubscription: true },
  );

  const transaction = await fakeTransaction({
    OrderId: order.id,
    FromCollectiveId: contributor.CollectiveId,
    CollectiveId: collective.id,
    HostCollectiveId: host.id,
    PaymentMethodId: paymentMethod.id,
    type: 'CREDIT',
    kind: TransactionKind.CONTRIBUTION,
    amount: 10000,
    amountInHostCurrency: 10000,
    currency: 'USD',
    hostCurrency: 'USD',
  });

  // Register the contributor as a BACKER of the collective (public profile).
  await models.Member.create({
    CollectiveId: collective.id,
    MemberCollectiveId: contributor.CollectiveId,
    role: 'BACKER',
    CreatedByUserId: contributor.id,
  });

  return { host, hostAdmin, collective, collectiveAdmin, contributor, order, transaction, paymentMethod };
};

describe('server/graphql/v2/mutation/OrderMutations - manageOrder', () => {
  let sandbox, refundStub;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    // Replace the authoritative refundTransaction helper so we don't hit Stripe;
    // each test overrides the behavior (resolve / reject) as needed.
    refundStub = sandbox.stub(TransactionMutationHelpers, 'refundTransaction');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('auth', () => {
    it('rejects unauthenticated callers', async () => {
      const { order } = await setupOrderScenario();
      const result = await graphqlQueryV2(MANAGE_ORDER_MUTATION, {
        order: { legacyId: order.id },
        action: { cancel: true, removeAsContributor: false },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/logged in/);
    });

    it('rejects collective admins (not host admins)', async () => {
      const { order, collectiveAdmin } = await setupOrderScenario();
      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: { cancel: true, removeAsContributor: false },
        },
        collectiveAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/permission to manage this contribution/);
    });

    it('rejects random users', async () => {
      const { order } = await setupOrderScenario();
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: { cancel: true, removeAsContributor: false },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/permission to manage this contribution/);
    });
  });

  describe('validation', () => {
    it('rejects empty actions (nothing to do)', async () => {
      const { order, hostAdmin } = await setupOrderScenario();
      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: { cancel: false, removeAsContributor: false },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/at least one of: cancel, refund, or removeAsContributor/);
    });

    it('rejects cancelling a one-time contribution', async () => {
      const { hostAdmin, collective, contributor } = await setupOrderScenario();
      const oneTimeOrder = await fakeOrder({
        CreatedByUserId: contributor.id,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        status: OrderStatuses.PAID,
        totalAmount: 5000,
      });

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: oneTimeOrder.id },
          action: { cancel: true, removeAsContributor: false },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Only recurring contributions can be cancelled/);
    });

    it('rejects refunding a transaction that does not belong to the order', async () => {
      const { order, hostAdmin, host, collective, contributor } = await setupOrderScenario();
      const otherTransaction = await fakeTransaction({
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        amount: 1000,
      });

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: {
            cancel: false,
            removeAsContributor: false,
            refund: { transactions: [{ legacyId: otherTransaction.id }] },
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/does not belong to this order/);
    });

    it('rejects a message that is too long', async () => {
      const { order, hostAdmin } = await setupOrderScenario();
      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: {
            cancel: true,
            removeAsContributor: false,
            messageForContributor: 'a'.repeat(2001),
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/at most 2000 characters/);
    });
  });

  describe('execution', () => {
    it('cancel-only: deactivates the subscription and flips the status', async () => {
      const { order, hostAdmin } = await setupOrderScenario();
      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: { cancel: true, removeAsContributor: false },
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.manageOrder.order.status).to.equal('CANCELLED');
      expect(result.data.manageOrder.refundedTransactions).to.deep.equal([]);
      expect(result.data.manageOrder.refundErrors).to.deep.equal([]);

      const reloaded = await order.reload({ include: [models.Subscription] });
      expect(reloaded.status).to.equal(OrderStatuses.CANCELLED);
      expect(reloaded.Subscription.isActive).to.equal(false);

      await waitForCondition(() =>
        models.Activity.count({ where: { OrderId: order.id, type: 'subscription.canceled.by.host' } }).then(c => c > 0),
      );
    });

    it('refund-only: calls refundTransaction with ignoreBalanceCheck=true and returns the refunded transaction', async () => {
      const { order, transaction, hostAdmin } = await setupOrderScenario();

      // Stub behavior: return the same transaction object as the "refunded" one.
      refundStub.resolves(transaction);

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: {
            cancel: false,
            removeAsContributor: false,
            refund: { transactions: [{ legacyId: transaction.id }] },
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.manageOrder.refundedTransactions).to.have.length(1);
      expect(result.data.manageOrder.refundErrors).to.deep.equal([]);
      expect(refundStub.calledOnce).to.equal(true);
      const [, , refundKind, options] = refundStub.firstCall.args;
      expect(refundKind).to.equal(RefundKind.REFUND);
      expect(options).to.include({ ignoreBalanceCheck: true });
    });

    it('removeAsContributor-only: destroys the BACKER membership', async () => {
      const { order, collective, contributor, hostAdmin } = await setupOrderScenario();

      const before = await models.Member.count({
        where: { CollectiveId: collective.id, MemberCollectiveId: contributor.CollectiveId, role: 'BACKER' },
      });
      expect(before).to.equal(1);

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: { cancel: false, removeAsContributor: true },
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;

      const after = await models.Member.count({
        where: { CollectiveId: collective.id, MemberCollectiveId: contributor.CollectiveId, role: 'BACKER' },
      });
      expect(after).to.equal(0);
    });

    it('combined: cancel + refund + removeAsContributor applies all effects', async () => {
      const { order, transaction, collective, contributor, hostAdmin } = await setupOrderScenario();
      refundStub.resolves(transaction);

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: {
            cancel: true,
            removeAsContributor: true,
            refund: { transactions: [{ legacyId: transaction.id }] },
            messageForContributor: 'Sorry, we cannot continue to support this contribution.',
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.manageOrder.order.status).to.equal('CANCELLED');
      expect(result.data.manageOrder.refundedTransactions).to.have.length(1);
      expect(result.data.manageOrder.refundErrors).to.deep.equal([]);

      const memberCount = await models.Member.count({
        where: { CollectiveId: collective.id, MemberCollectiveId: contributor.CollectiveId, role: 'BACKER' },
      });
      expect(memberCount).to.equal(0);
    });

    it('soft refund error: one tx fails, the mutation still succeeds and reports the error with a stable code', async () => {
      const { order, transaction, host, collective, contributor, hostAdmin } = await setupOrderScenario();
      const secondTransaction = await fakeTransaction({
        OrderId: order.id,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        amount: 5000,
      });

      refundStub
        .onFirstCall()
        .rejects(new Error('Charge has already been refunded'))
        .onSecondCall()
        .resolves(secondTransaction);

      const result = await graphqlQueryV2(
        MANAGE_ORDER_MUTATION,
        {
          order: { legacyId: order.id },
          action: {
            cancel: false,
            removeAsContributor: false,
            refund: {
              transactions: [{ legacyId: transaction.id }, { legacyId: secondTransaction.id }],
            },
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.manageOrder.refundedTransactions).to.have.length(1);
      expect(result.data.manageOrder.refundErrors).to.have.length(1);
      expect(result.data.manageOrder.refundErrors[0].code).to.equal('ALREADY_REFUNDED');
    });
  });

  describe('Order.permissions', () => {
    it('exposes canHost* correctly for host admins on a refundable recurring order', async () => {
      const { order, hostAdmin } = await setupOrderScenario();
      const encodedId = idEncode(order.id, IDENTIFIER_TYPES.ORDER);

      const result = await graphqlQueryV2(ORDER_PERMISSIONS_QUERY, { id: encodedId }, hostAdmin);

      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canHostCancel).to.equal(true);
      expect(result.data.order.permissions.canHostRefund).to.equal(true);
      expect(result.data.order.permissions.canHostRemoveAsContributor).to.equal(true);
    });

    it('returns canHost* = false for non-host-admins', async () => {
      const { order, collectiveAdmin } = await setupOrderScenario();
      const encodedId = idEncode(order.id, IDENTIFIER_TYPES.ORDER);
      const result = await graphqlQueryV2(ORDER_PERMISSIONS_QUERY, { id: encodedId }, collectiveAdmin);

      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canHostCancel).to.equal(false);
      expect(result.data.order.permissions.canHostRefund).to.equal(false);
      expect(result.data.order.permissions.canHostRemoveAsContributor).to.equal(false);
    });
  });
});
