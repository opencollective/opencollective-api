import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { isNil } from 'lodash';

import activities from '../../../constants/activities';
import status from '../../../constants/order_status';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { confirmOrder as confirmOrderLegacy, createOrder as createOrderLegacy } from '../../v1/mutations/orders';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { getDecodedId } from '../identifiers';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { OrderCreateInput } from '../input/OrderCreateInput';
import { fetchOrderWithReference, OrderReferenceInput } from '../input/OrderReferenceInput';
import { getLegacyPaymentMethodFromPaymentMethodInput } from '../input/PaymentMethodInput';
import { fetchPaymentMethodWithReference, PaymentMethodReferenceInput } from '../input/PaymentMethodReferenceInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';
import { StripeError } from '../object/StripeError';

const modelArray = [
  { model: models.Subscription },
  { model: models.Collective, as: 'collective' },
  { model: models.Collective, as: 'fromCollective' },
];

const OrderWithPayment = new GraphQLObjectType({
  name: 'OrderWithPayment',
  fields: {
    order: {
      type: new GraphQLNonNull(Order),
      description: 'The order created',
    },
    stripeError: {
      type: StripeError,
      description:
        'This field will be set if the order was created but there was an error with Stripe during the payment',
    },
  },
});

const orderMutations = {
  createOrder: {
    type: GraphQLNonNull(OrderWithPayment),
    description: 'To submit a new order',
    args: {
      order: {
        type: new GraphQLNonNull(OrderCreateInput),
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Error('Unauthenticated orders are not supported yet');
      } else if (args.order.taxes?.length > 1) {
        throw new Error('Attaching multiple taxes is not supported yet');
      }

      const getOrderTotalAmount = ({ platformContributionAmount, taxes, quantity }) => {
        let totalAmount = getValueInCentsFromAmountInput(order.amount) * quantity;
        totalAmount += platformContributionAmount ? getValueInCentsFromAmountInput(platformContributionAmount) : 0;
        totalAmount += taxes?.[0].amount ? getValueInCentsFromAmountInput(taxes[0].amount) : 0;
        return totalAmount;
      };

      const { order } = args;
      const { platformContributionAmount } = order;
      const tax = order.taxes?.[0];
      const platformFee = platformContributionAmount && getValueInCentsFromAmountInput(platformContributionAmount);
      const loadAccount = account => fetchAccountWithReference(account, { loaders: req.loaders, throwIfMissing: true });
      const tier = order.tier && (await fetchTierWithReference(order.tier, { loaders: req.loaders }));

      const legacyOrderObj = {
        quantity: order.quantity,
        amount: getValueInCentsFromAmountInput(order.amount),
        interval: getIntervalFromContributionFrequency(order.frequency),
        taxAmount: tax && getValueInCentsFromAmountInput(tax.amount),
        countryISO: tax?.country,
        taxIdNumber: tax?.idNumber,
        isFeesOnTop: !isNil(platformFee),
        paymentMethod: await getLegacyPaymentMethodFromPaymentMethodInput(order.paymentMethod),
        fromCollective: await loadAccount(order.fromAccount),
        collective: await loadAccount(order.toAccount),
        totalAmount: getOrderTotalAmount(order),
        tier,
        platformFee,
      };

      const orderCreated = await createOrderLegacy(legacyOrderObj, req.loaders, req.remoteUser, req.ip);
      return { order: orderCreated, stripeError: orderCreated.stripeError };
    },
  },
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
        type: AmountInput,
        description: 'An Amount to update the order to',
      },
    },
    async resolve(_, args, req) {
      const decodedId = getDecodedId(args.order.id);

      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to update a order');
      }

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
      if (args.paymentMethod !== undefined) {
        // unlike v1 we don't have to check/assign new payment method, that will be taken care of in another mutation
        const newPaymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod);

        if (!req.remoteUser.isAdmin(newPaymentMethod.CollectiveId)) {
          throw new Unauthorized("You don't have permission to use this payment method");
        }

        const newStatus = order.status === status.ERROR ? status.ACTIVE : order.status;
        order = await order.update({ PaymentMethodId: newPaymentMethod.id, status: newStatus });
      }

      // amount and tier (will always go together)
      if (args.amount !== undefined && args.tier !== undefined) {
        let tierInfo;

        // get tier info if it's a named tier
        if (args.tier.id !== null) {
          tierInfo = await fetchTierWithReference(args.tier);
          if (!tierInfo) {
            throw new Error(`No tier found with tier id: ${args.tier.id} for collective ${order.CollectiveId}`);
          } else if (tierInfo.CollectiveId !== order.CollectiveId) {
            throw new Error(
              `This tier (#${tierInfo.id}) doesn't belong to the given Collective #${order.CollectiveId}`,
            );
          }
        }

        const amountInCents = getValueInCentsFromAmountInput(args.amount);

        // The amount can never be less than $1.00
        if (amountInCents < 100) {
          throw new Error('Invalid amount.');
        }

        // If using a named tier, amount can never be less than the minimum amount
        if (tierInfo && tierInfo.amountType === 'FLEXIBLE' && amountInCents < tierInfo.minimumAmount) {
          throw new Error('Amount is less than minimum value allowed for this Tier.');
        }

        // check if the amount is different from the previous amount
        if (amountInCents !== order.totalAmount) {
          order = await order.update({ totalAmount: amountInCents });
        }

        // Custom contribution is null, named tier will be tierInfo.id
        const tierToUpdateWith = tierInfo ? tierInfo.id : null;
        order = await order.update({ TierId: tierToUpdateWith });
      }

      return order;
    },
  },
  confirmOrder: {
    type: new GraphQLNonNull(OrderWithPayment),
    args: {
      order: {
        type: new GraphQLNonNull(OrderReferenceInput),
      },
    },
    async resolve(_, args, req) {
      const baseOrder = await fetchOrderWithReference(args.order);
      const updatedOrder = await confirmOrderLegacy(baseOrder, req.remoteUser);
      return {
        order: updatedOrder,
        stripeError: updatedOrder.stripeError,
      };
    },
  },
};

export default orderMutations;
