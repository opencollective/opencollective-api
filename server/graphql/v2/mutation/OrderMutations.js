import { GraphQLInt, GraphQLNonNull } from 'graphql';

import activities from '../../../constants/activities';
import status from '../../../constants/order_status';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { getDecodedId } from '../identifiers';
import { OrderReferenceInput } from '../input/OrderReferenceInput';
import { PaymentMethodReferenceInput } from '../input/PaymentMethodReferenceInput';
import { TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';

const modelArray = [
  { model: models.Subscription },
  { model: models.Collective, as: 'collective' },
  { model: models.Collective, as: 'fromCollective' },
];

const orderMutations = {
  cancelOrder: {
    type: Order,
    description: 'Cancel an order',
    args: {
      order: {
        type: new GraphQLNonNull(OrderReferenceInput),
        description: 'Object matching the OrderReferenceInput (id)',
      },
    },
    async resolve(_, args, req) {
      const decodedId = getDecodedId(args.order.id);

      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to cancel a recurring contribution');
      }

      const query = {
        where: {
          id: decodedId,
        },
        include: modelArray,
      };

      const order = await models.Order.findOne(query);

      if (!order) {
        throw new NotFound('Recurring contribution not found');
      }
      if (!req.remoteUser.isAdmin(order.FromCollectiveId)) {
        throw new Unauthorized("You don't have permission to cancel this recurring contribution");
      }
      if (!order.Subscription.isActive && order.status === status.CANCELLED) {
        throw new Error('Recurring contribution already canceled');
      }

      await order.update({ status: status.CANCELLED });
      await order.Subscription.deactivate();
      await models.Activity.create({
        type: activities.SUBSCRIPTION_CANCELED,
        CollectiveId: order.CollectiveId,
        UserId: order.CreatedByUserId,
        data: {
          subscription: order.Subscription,
          collective: order.collective.minimal,
          user: req.remoteUser.minimal,
          fromCollective: order.fromCollective.minimal,
        },
      });

      return models.Order.findOne(query);
    },
  },
  activateOrder: {
    type: Order,
    description: 'Reactivate a cancelled order',
    args: {
      order: {
        type: new GraphQLNonNull(OrderReferenceInput),
        description: 'Object matching the OrderReferenceInput (id)',
      },
    },
    async resolve(_, args, req) {
      const decodedId = getDecodedId(args.order.id);

      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to activate a recurring contribution');
      }

      const query = {
        where: {
          id: decodedId,
        },
        include: modelArray,
      };

      const order = await models.Order.findOne(query);

      if (!order) {
        throw new NotFound('Recurring contribution not found');
      }
      if (!req.remoteUser.isAdmin(order.FromCollectiveId)) {
        throw new Unauthorized("You don't have permission to cancel this recurring contribution");
      }
      if (order.Subscription.isActive && order.status === status.ACTIVE) {
        throw new Error('Recurring contribution already active');
      }

      await order.update({ status: status.ACTIVE });
      await order.Subscription.activate();
      await models.Activity.create({
        type: activities.SUBSCRIPTION_ACTIVATED,
        CollectiveId: order.CollectiveId,
        UserId: order.CreatedByUserId,
        data: {
          subscription: order.Subscription,
          collective: order.collective.minimal,
          user: req.remoteUser.minimal,
          fromCollective: order.fromCollective.minimal,
        },
      });

      return models.Order.findOne(query);
    },
  },
  updateOrder: {
    type: Order,
    description: "Update an Order's amount, tier, or payment method",
    args: {
      order: {
        type: new GraphQLNonNull(OrderReferenceInput),
        description: 'Reference to the Order to update',
      },
      paymentMethod: {
        type: PaymentMethodReferenceInput,
        description: 'Reference to a Payment Method to update the order with',
      },
      tier: {
        type: TierReferenceInput,
        description: 'Reference to a Tier to update the order with',
      },
      amount: {
        type: GraphQLInt,
        description: 'An Amount to update the order to',
      },
    },
    async resolve(_, args, req) {
      const decodedId = getDecodedId(args.order.id);

      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to update a order');
      }

      const { paymentMethod, amount, tier } = args;

      const query = {
        where: {
          id: decodedId,
        },
        include: [{ model: models.Subscription }],
      };

      let order = await models.Order.findOne(query);

      if (!order) {
        throw new NotFound('Order not found');
      }
      if (!req.remoteUser.isAdmin(order.FromCollectiveId)) {
        throw new Unauthorized("You don't have permission to update this order");
      }
      if (!order.Subscription.isActive) {
        throw new Error('Order must be active to be updated');
      }

      // payment method
      if (paymentMethod !== undefined) {
        // unlike v1 we don't have to check/assign new payment method, that will be taken care of in another mutation
        const newPaymentMethod = await models.PaymentMethod.findOne({
          where: { id: paymentMethod.legacyId },
        });
        if (!newPaymentMethod) {
          throw new Error('Payment method not found with this id', paymentMethod.legacyId);
        }
        if (!req.remoteUser.isAdmin(newPaymentMethod.CollectiveId)) {
          throw new Unauthorized("You don't have permission to use this payment method");
        }

        order = await order.update({ PaymentMethodId: newPaymentMethod.id });
      }

      // tier
      let tierInfo;
      // get tier info if it's a named tier
      if (tier.legacyId !== null) {
        tierInfo = await models.Tier.findByPk(tier.legacyId);
        if (!tierInfo) {
          throw new Error(`No tier found with tier id: ${tier.legacyId} for collective ${order.CollectiveId}`);
        } else if (tierInfo.CollectiveId !== order.CollectiveId) {
          throw new Error(`This tier (#${tierInfo.id}) doesn't belong to the given Collective #${order.CollectiveId}`);
        }
      }
      // check if the tier is different from the previous tier
      if (tier.legacyId !== order.TierId) {
        order = await order.update({ TierId: tier.legacyId });
      }

      // amount
      if (amount !== order.totalAmount) {
        if (amount < 100) {
          throw new Error('Invalid amount.');
        }

        // If using a named tier, amount can never be less than the minimum amount
        if (tierInfo && tierInfo.amountType === 'FLEXIBLE' && amount < tierInfo.minimumAmount) {
          throw new Error('Amount is less than minimum value allowed for this Tier.');
        }

        order = await order.update({ totalAmount: amount });
      }

      return order;
    },
  },
};

export default orderMutations;
