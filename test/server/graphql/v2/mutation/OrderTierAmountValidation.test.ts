import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order-status';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakeOrganization,
  fakeTier,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2, resetTestDB } from '../../../../utils';

const UPDATE_ORDER_MUTATION = gql`
  mutation UpdateOrder($order: OrderReferenceInput!, $amount: AmountInput, $tier: TierReferenceInput) {
    updateOrder(order: $order, amount: $amount, tier: $tier) {
      id
      amount {
        valueInCents
      }
      tier {
        id
      }
    }
  }
`;

const CREATE_PENDING_ORDER_MUTATION = gql`
  mutation CreatePendingOrder($order: PendingOrderCreateInput!) {
    createPendingOrder(order: $order) {
      id
      amount {
        valueInCents
      }
      tier {
        id
      }
    }
  }
`;

const EDIT_PENDING_ORDER_MUTATION = gql`
  mutation EditPendingOrder($order: PendingOrderEditInput!) {
    editPendingOrder(order: $order) {
      id
      amount {
        valueInCents
      }
      tier {
        id
      }
    }
  }
`;

const ADD_FUNDS_MUTATION = gql`
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
    $tier: TierReferenceInput
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
      tier: $tier
    ) {
      id
      amount {
        valueInCents
      }
      tier {
        id
      }
    }
  }
`;

const EDIT_ADDED_FUNDS_MUTATION = gql`
  mutation EditAddedFunds(
    $order: OrderReferenceInput!
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $tier: TierReferenceInput
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
  ) {
    editAddedFunds(
      order: $order
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
      tier: $tier
    ) {
      id
      amount {
        valueInCents
      }
      tier {
        id
      }
    }
  }
`;

const MOVE_ORDERS_MUTATION = gql`
  mutation MoveOrders(
    $orders: [OrderReferenceInput!]!
    $fromAccount: AccountReferenceInput
    $makeIncognito: Boolean
    $tier: TierReferenceInput
    $force: Boolean
  ) {
    moveOrders(orders: $orders, fromAccount: $fromAccount, makeIncognito: $makeIncognito, tier: $tier, force: $force) {
      id
      tier {
        id
      }
    }
  }
`;

/**
 * The amount of an order must always match the tier it is attributed to:
 * fixed tiers have an exact price, flexible tiers have a minimum. These rules
 * must be enforced by every mutation that can create this association
 * (or change the amount of a tiered order).
 */
describe('Order amount vs. tier validation', () => {
  let user, host, hostAdmin, collective, sameHostAccount, contributor, fixedTier, flexibleTier, rootUser;

  before(async () => {
    await resetTestDB();
    hostAdmin = await fakeUser();
    host = await fakeHost({ plan: 'start-plan-2021', admin: hostAdmin });
    await host.update({ data: { isTrustedHost: true } });
    collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id });
    sameHostAccount = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id });
    user = await fakeUser();
    contributor = await fakeUser();

    // A tier that costs exactly $100
    fixedTier = await fakeTier({
      CollectiveId: collective.id,
      currency: 'USD',
      amount: 10000,
      amountType: 'FIXED',
    });

    // A tier with a $100 minimum
    flexibleTier = await fakeTier({
      CollectiveId: collective.id,
      currency: 'USD',
      amount: 10000,
      minimumAmount: 10000,
      presets: [10000, 20000],
      amountType: 'FLEXIBLE',
    });

    // Root user for `moveOrders`
    const rootOrg = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, slug: randStr('platform-') });
    rootUser = await fakeUser({ data: { isRoot: true } }, { name: 'Root user' }, { enable2FA: true });
    await rootOrg.addUserWithRole(rootUser, 'ADMIN');
    await rootUser.populateRoles();
  });

  const createRecurringOrder = (totalAmount: number) =>
    fakeOrder(
      {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        status: OrderStatuses.ACTIVE,
        totalAmount,
        platformTipAmount: 0,
        TierId: null,
        currency: 'USD',
      },
      { withSubscription: true },
    );

  const callMoveOrders = (orders, tier, { force = false } = {}) =>
    graphqlQueryV2(
      MOVE_ORDERS_MUTATION,
      {
        fromAccount: null,
        makeIncognito: false,
        tier: tier === 'custom' ? { isCustom: true } : { legacyId: tier.id },
        orders: orders.map(order => ({ id: idEncode(order.id, 'order') })),
        force,
      },
      rootUser,
      undefined,
      { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(rootUser) },
    );

  describe('updateOrder', () => {
    it('rejects attaching a fixed tier to an order below the tier amount', async () => {
      const order = await createRecurringOrder(100); // $1
      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        { order: { id: idEncode(order.id, 'order') }, tier: { legacyId: fixedTier.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.totalAmount).to.eq(100);
    });

    it('rejects attaching a flexible tier below its minimum', async () => {
      const order = await createRecurringOrder(100); // $1
      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        {
          order: { id: idEncode(order.id, 'order') },
          tier: { legacyId: flexibleTier.id },
          amount: { valueInCents: 100 },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/below minimum tier value/);
      await order.reload();
      expect(order.TierId).to.be.null;
    });

    it('rejects amounts above the price of a fixed tier', async () => {
      const order = await createRecurringOrder(100);
      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        {
          order: { id: idEncode(order.id, 'order') },
          tier: { legacyId: fixedTier.id },
          amount: { valueInCents: 15000 },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
      await order.reload();
      expect(order.TierId).to.be.null;
    });

    it('accepts an amount matching the fixed tier', async () => {
      const order = await createRecurringOrder(100);
      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        {
          order: { id: idEncode(order.id, 'order') },
          tier: { legacyId: fixedTier.id },
          amount: { valueInCents: 10000 },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
      expect(order.totalAmount).to.eq(10000);
    });

    it('accepts orders with a null quantity', async () => {
      const order = await createRecurringOrder(10000);
      await order.update({ quantity: null }); // Legacy orders can have no quantity

      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        {
          order: { id: idEncode(order.id, 'order') },
          tier: { legacyId: fixedTier.id },
          amount: { valueInCents: 10000 },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
    });

    it('accepts an amount matching the fixed tier when taxes apply', async () => {
      const order = await createRecurringOrder(12000);
      await order.update({ taxAmount: 2000, data: { tax: { id: 'VAT', percentage: 20 } } });

      const result = await graphqlQueryV2(
        UPDATE_ORDER_MUTATION,
        {
          order: { id: idEncode(order.id, 'order') },
          tier: { legacyId: fixedTier.id },
          amount: { valueInCents: 12000 }, // $100 + $20 tax
        },
        user,
      );

      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
    });
  });

  describe('createPendingOrder', () => {
    const callCreatePendingOrder = (amountInCents, tier) =>
      graphqlQueryV2(
        CREATE_PENDING_ORDER_MUTATION,
        {
          order: {
            fromAccount: { legacyId: sameHostAccount.id },
            toAccount: { legacyId: collective.id },
            amount: { valueInCents: amountInCents, currency: 'USD' },
            description: 'Pending contribution',
            tier: tier && { legacyId: tier.id },
          },
        },
        hostAdmin,
      );

    it('rejects a fixed tier with an amount below the tier price', async () => {
      const result = await callCreatePendingOrder(100, fixedTier); // $1 for a $100 tier
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
    });

    it('accepts an amount matching the fixed tier', async () => {
      const result = await callCreatePendingOrder(10000, fixedTier);
      expect(result.errors).to.not.exist;
      expect(result.data.createPendingOrder.tier.id).to.exist;
    });
  });

  describe('editPendingOrder', () => {
    const callEditPendingOrder = (order, amountInCents, tier) =>
      graphqlQueryV2(
        EDIT_PENDING_ORDER_MUTATION,
        {
          order: {
            legacyId: order.id,
            fromAccount: { legacyId: sameHostAccount.id },
            amount: { valueInCents: amountInCents, currency: 'USD' },
            description: 'Edited pending contribution',
            tier: tier && { legacyId: tier.id },
          },
        },
        hostAdmin,
      );

    const createPendingContribution = (amountInCents: number) =>
      fakeOrder({
        status: OrderStatuses.PENDING,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        totalAmount: amountInCents,
        currency: 'USD',
        data: { isPendingContribution: true },
      });

    it('rejects attributing a fixed tier to an amount below the tier price', async () => {
      const order = await createPendingContribution(100); // $1 contribution without tier

      const result = await callEditPendingOrder(order, 100, fixedTier); // $1 for a $100 tier
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.totalAmount).to.eq(100);
    });

    it('accepts attributing a fixed tier when the amount matches', async () => {
      const order = await createPendingContribution(100);

      const result = await callEditPendingOrder(order, 10000, fixedTier);
      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
    });

    it('rejects lowering the amount of a tiered order below the tier minimum', async () => {
      const order = await fakeOrder({
        status: OrderStatuses.PENDING,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        totalAmount: 10000,
        TierId: flexibleTier.id,
        currency: 'USD',
        data: { isPendingContribution: true },
      });

      const result = await callEditPendingOrder(order, 100, flexibleTier); // $1 for a $100-minimum tier
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/below minimum tier value/);
      await order.reload();
      expect(order.totalAmount).to.eq(10000);
    });

    it('validates against the existing tier when the tier input is omitted', async () => {
      const order = await fakeOrder({
        status: OrderStatuses.PENDING,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        totalAmount: 10000,
        TierId: fixedTier.id,
        currency: 'USD',
        data: { isPendingContribution: true },
      });

      const result = await graphqlQueryV2(
        EDIT_PENDING_ORDER_MUTATION,
        {
          order: {
            legacyId: order.id,
            fromAccount: { legacyId: sameHostAccount.id },
            amount: { valueInCents: 100, currency: 'USD' },
            description: 'Edited pending contribution',
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
      await order.reload();
      expect(order.totalAmount).to.eq(10000);
    });
  });

  describe('addFunds / editAddedFunds', () => {
    const callAddFunds = (amountInCents, tier) =>
      graphqlQueryV2(
        ADD_FUNDS_MUTATION,
        {
          fromAccount: { legacyId: contributor.CollectiveId },
          account: { legacyId: collective.id },
          amount: { valueInCents: amountInCents, currency: 'USD' },
          description: 'Added funds',
          hostFeePercent: 0,
          tier: tier && { legacyId: tier.id },
        },
        hostAdmin,
      );

    it('rejects adding funds with a fixed tier and an amount below the tier price', async () => {
      const result = await callAddFunds(100, fixedTier); // $1 for a $100 tier
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
    });

    it('accepts adding funds with a fixed tier when the amount matches', async () => {
      const result = await callAddFunds(10000, fixedTier);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.tier.id).to.exist;
    });

    it('rejects editing added funds to attribute a fixed tier below the tier price', async () => {
      const addResult = await callAddFunds(100, null); // $1 added funds without tier
      expect(addResult.errors).to.not.exist;
      const order = addResult.data.addFunds;

      const result = await graphqlQueryV2(
        EDIT_ADDED_FUNDS_MUTATION,
        {
          order: { id: order.id },
          fromAccount: { legacyId: contributor.CollectiveId },
          account: { legacyId: collective.id },
          amount: { valueInCents: 100, currency: 'USD' },
          description: 'Edited added funds',
          hostFeePercent: 0,
          tier: { legacyId: fixedTier.id },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
    });
  });

  describe('moveOrders', () => {
    it('rejects moving an order to a tier whose price does not match the order amount', async () => {
      const order = await createRecurringOrder(100); // $1
      const result = await callMoveOrders([order], fixedTier);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This tier uses a fixed amount/);
      await order.reload();
      expect(order.TierId).to.be.null;
    });

    it('allows forcing the move for data-repair purposes', async () => {
      const order = await createRecurringOrder(100); // $1
      const result = await callMoveOrders([order], fixedTier, { force: true });
      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
    });

    it('allows moving an order to the custom (no) tier', async () => {
      const order = await createRecurringOrder(100);
      await order.update({ TierId: fixedTier.id });
      const result = await callMoveOrders([order], 'custom');
      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.be.null;
    });

    it('accepts moving an order to a matching tier', async () => {
      const order = await createRecurringOrder(10000); // $100
      const result = await callMoveOrders([order], fixedTier);
      expect(result.errors).to.not.exist;
      await order.reload();
      expect(order.TierId).to.eq(fixedTier.id);
    });
  });
});
