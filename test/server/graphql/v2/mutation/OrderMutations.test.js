import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { roles } from '../../../../../server/constants';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import { fakeCollective, fakeOrder, fakePaymentMethod, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const updateOrderMutation = gqlV2/* GraphQL */ `
  mutation UpdateOrder(
    $order: OrderReferenceInput!
    $amount: AmountInput
    $tier: TierReferenceInput
    $paymentMethod: PaymentMethodReferenceInput
  ) {
    updateOrder(order: $order, amount: $amount, tier: $tier, paymentMethod: $paymentMethod) {
      id
      status
      amount {
        value
        currency
      }
      tier {
        id
        name
      }
      paymentMethod {
        id
      }
    }
  }
`;

const cancelRecurringContributionMutation = gqlV2/* GraphQL */ `
  mutation CancelRecurringContribution($order: OrderReferenceInput!) {
    cancelOrder(order: $order) {
      id
      status
    }
  }
`;

describe('server/graphql/v2/mutation/OrderMutations', () => {
  let adminUser, user, randomUser, collective, order, order2, paymentMethod, paymentMethod2, fixedTier, flexibleTier;

  before(async () => {
    adminUser = await fakeUser();
    user = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    order = await fakeOrder(
      {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        status: 'ACTIVE',
      },
      {
        withSubscription: true,
      },
    );
    order2 = await fakeOrder(
      {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        status: 'ACTIVE',
      },
      {
        withSubscription: true,
      },
    );
    paymentMethod = await fakePaymentMethod({
      service: 'stripe',
      type: 'creditcard',
      data: {
        expMonth: 11,
        expYear: 2025,
      },
      CollectiveId: user.CollectiveId,
      token: 'tok_5B5j8xDjPFcHOcTm3ogdnq0K',
    });
    paymentMethod2 = await fakePaymentMethod({
      service: 'stripe',
      type: 'creditcard',
      data: {
        expMonth: 11,
        expYear: 2025,
      },
      CollectiveId: randomUser.CollectiveId,
      token: 'tok_5B5j8xDjPFcHOcTm3ogdnq0K',
    });
    fixedTier = await fakeTier({
      CollectiveId: collective.id,
      amount: 7300,
      amountType: 'FIXED',
    });
    flexibleTier = await fakeTier({
      CollectiveId: collective.id,
      minimumAmount: 500,
      amount: 500,
      presets: [500, 750, 1000],
      amountType: 'FLEXIBLE',
    });
    await collective.addUserWithRole(adminUser, roles.ADMIN);
  });

  describe('cancelOrder', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(cancelRecurringContributionMutation, {
        order: { id: idEncode(order.id, 'order') },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be logged in to cancel a recurring contribution/);
    });

    it('must be user who created the order', async () => {
      const result = await graphqlQueryV2(
        cancelRecurringContributionMutation,
        {
          order: { id: idEncode(order.id, 'order') },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You don't have permission to cancel this recurring contribution/);
    });

    it('cancels the order', async () => {
      const result = await graphqlQueryV2(
        cancelRecurringContributionMutation,
        {
          order: { id: idEncode(order.id, 'order') },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.cancelOrder.status).to.eq('CANCELLED');
    });

    it('cannot cancel an already cancelled order', async () => {
      const result = await graphqlQueryV2(
        cancelRecurringContributionMutation,
        {
          order: { id: idEncode(order.id, 'order') },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Recurring contribution already canceled/);
    });
  });

  describe('updateOrder', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(updateOrderMutation, {
        order: { id: idEncode(order2.id, 'order') },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be logged in to update a order/);
    });

    it('must be user who created the order', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          amount: {
            value: 1000 / 100, // $10.00
          },
          tier: null, // null or named tier
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You don't have permission to update this order/);
    });

    it('cannot update an already cancelled order', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order.id, 'order') },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Order must be active to be updated/);
    });

    it('cannot update an order with a payment method they do not own', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          paymentMethod: {
            id: idEncode(paymentMethod2.id, 'paymentMethod'),
          },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You don't have permission to use this payment method/);
    });

    it('cannot update an order with an amount that does not match the fixed tier', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          amount: {
            value: 1000 / 100,
          },
          tier: { legacyId: fixedTier.id }, // null or named tier
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Amount is incorrect for this Tier./);
    });

    it('cannot update an order with an amount less than the tier minimum', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          amount: {
            value: 200 / 100, // $2.00
          },
          tier: { legacyId: flexibleTier.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Amount is less than minimum value allowed for this Tier./);
    });

    it('updates the order payment method', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          paymentMethod: {
            id: idEncode(paymentMethod.id, 'paymentMethod'),
          },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.paymentMethod.id).to.eq(idEncode(paymentMethod.id, 'paymentMethod'));
    });

    it('updates the order tier and amount', async () => {
      const result = await graphqlQueryV2(
        updateOrderMutation,
        {
          order: { id: idEncode(order2.id, 'order') },
          amount: {
            value: 7300 / 100,
          },
          tier: { legacyId: fixedTier.id },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.amount.value).to.eq(73);
      expect(result.data.updateOrder.tier.name).to.eq(fixedTier.name);
    });
  });
});
