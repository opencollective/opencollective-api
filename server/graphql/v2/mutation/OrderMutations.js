import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { difference, flatten, isEmpty, isNull, isUndefined, keyBy, keys, mapValues, pick, uniq, uniqBy } from 'lodash';

import { roles } from '../../../constants';
import activities from '../../../constants/activities';
import status from '../../../constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { purgeAllCachesForAccount } from '../../../lib/cache';
import {
  updateOrderSubscription,
  updatePaymentMethodForSubscription,
  updateSubscriptionDetails,
} from '../../../lib/subscriptions';
import models, { Op, sequelize } from '../../../models';
import { MigrationLogType } from '../../../models/MigrationLog';
import { updateSubscriptionWithPaypal } from '../../../paymentProviders/paypal/subscription';
import { BadRequest, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { confirmOrder as confirmOrderLegacy, createOrder as createOrderLegacy } from '../../v1/mutations/orders';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { ProcessOrderAction } from '../enum/ProcessOrderAction';
import { getDecodedId } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { OrderCreateInput } from '../input/OrderCreateInput';
import { fetchOrdersWithReferences, fetchOrderWithReference, OrderReferenceInput } from '../input/OrderReferenceInput';
import { OrderUpdateInput } from '../input/OrderUpdateInput';
import { getLegacyPaymentMethodFromPaymentMethodInput } from '../input/PaymentMethodInput';
import { fetchPaymentMethodWithReference, PaymentMethodReferenceInput } from '../input/PaymentMethodReferenceInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';
import { canMarkAsExpired, canMarkAsPaid } from '../object/OrderPermissions';
import { StripeError } from '../object/StripeError';

const OrderWithPayment = new GraphQLObjectType({
  name: 'OrderWithPayment',
  fields: () => ({
    order: {
      type: new GraphQLNonNull(Order),
      description: 'The order created',
    },
    guestToken: {
      type: GraphQLString,
      description: 'If donating as a guest, this will contain your guest token to confirm your order',
    },
    stripeError: {
      type: StripeError,
      description:
        'This field will be set if the order was created but there was an error with Stripe during the payment',
    },
  }),
});

const orderMutations = {
  createOrder: {
    type: new GraphQLNonNull(OrderWithPayment),
    description: 'To submit a new order',
    args: {
      order: {
        type: new GraphQLNonNull(OrderCreateInput),
      },
    },
    async resolve(_, args, req) {
      if (args.order.taxes?.length > 1) {
        throw new Error('Attaching multiple taxes is not supported yet');
      }

      const getOrderTotalAmount = ({ platformTipAmount, taxes, quantity }) => {
        let totalAmount = getValueInCentsFromAmountInput(order.amount) * quantity;
        totalAmount += platformTipAmount ? getValueInCentsFromAmountInput(platformTipAmount) : 0;
        totalAmount += taxes?.[0].amount ? getValueInCentsFromAmountInput(taxes[0].amount) : 0;
        return totalAmount;
      };

      const { order } = args;
      const tax = order.taxes?.[0];
      const platformTip = order.platformTipAmount;
      const platformTipAmount = platformTip ? getValueInCentsFromAmountInput(platformTip) : 0;
      const loadersParams = { loaders: req.loaders, throwIfMissing: true };
      const loadAccount = account => fetchAccountWithReference(account, loadersParams);
      const tier = order.tier && (await fetchTierWithReference(order.tier, loadersParams));
      const fromCollective = order.fromAccount && (await loadAccount(order.fromAccount));
      const collective = await loadAccount(order.toAccount);

      const paymentMethod = await getLegacyPaymentMethodFromPaymentMethodInput(order.paymentMethod);

      const legacyOrderObj = {
        quantity: order.quantity,
        amount: getValueInCentsFromAmountInput(order.amount),
        interval: getIntervalFromContributionFrequency(order.frequency),
        taxAmount: tax && getValueInCentsFromAmountInput(tax.amount),
        taxType: tax?.type,
        countryISO: tax?.country,
        taxIDNumber: tax?.idNumber,
        paymentMethod,
        fromCollective: fromCollective && { id: fromCollective.id },
        fromAccountInfo: order.fromAccountInfo,
        collective: { id: collective.id },
        totalAmount: getOrderTotalAmount(order),
        data: order.data,
        customData: order.customData,
        isBalanceTransfer: order.isBalanceTransfer,
        tier: tier && { id: tier.id },
        guestInfo: order.guestInfo,
        context: order.context,
        tags: order.tags,
        platformTipAmount,
      };

      const userAgent = req.header('user-agent');
      const result = await createOrderLegacy(legacyOrderObj, req.loaders, req.remoteUser, req.ip, userAgent, req.mask);
      return { order: result.order, stripeError: result.stripeError, guestToken: result.order.data?.guestToken };
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
        where: { id: decodedId },
        include: [
          { association: 'paymentMethod' },
          { model: models.Subscription },
          { model: models.Collective, as: 'collective' },
          { model: models.Collective, as: 'fromCollective' },
        ],
      };

      const order = await models.Order.findOne(query);

      if (!order) {
        throw new NotFound('Recurring contribution not found');
      }

      const fromCollective = await req.loaders.Collective.byId.load(order.FromCollectiveId);
      if (!req.remoteUser.isAdminOfCollective(fromCollective)) {
        throw new Unauthorized("You don't have permission to cancel this recurring contribution");
      } else if (!order.Subscription?.isActive && order.status === status.CANCELLED) {
        throw new Error('Recurring contribution already canceled');
      } else if (order.status === status.PAID) {
        throw new Error('Cannot cancel a paid order');
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
      paypalSubscriptionId: {
        type: GraphQLString,
        description: 'To update the order with a PayPal subscription',
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
      const haveDetailsChanged = !isUndefined(args.amount) && !isUndefined(args.tier);
      const hasPaymentMethodChanged = !isUndefined(args.paymentMethod);

      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to update a order');
      }

      const order = await models.Order.findOne({
        where: { id: decodedId },
        include: [
          { model: models.Subscription, required: true },
          { association: 'collective', required: true },
          { association: 'fromCollective', required: true },
          { association: 'paymentMethod' },
        ],
      });

      if (!order) {
        throw new ValidationFailed('This order does not seem to exist');
      } else if (!req.remoteUser.isAdminOfCollective(order.fromCollective)) {
        throw new Unauthorized("You don't have permission to update this order");
      } else if (!order.Subscription.isActive) {
        throw new Error('Order must be active to be updated');
      } else if (args.paypalSubscriptionId && args.paymentMethod) {
        throw new Error('paypalSubscriptionId and paymentMethod are mutually exclusive');
      } else if (haveDetailsChanged && hasPaymentMethodChanged) {
        // There's no transaction/rollback strategy if updating the payment method fails
        // after updating the order. We could end up with partially migrated subscriptions
        // if we allow changing both at the same time.
        throw new Error(
          'Amount and payment method cannot be updated at the same time, please update one after the other',
        );
      }

      let previousOrderValues, previousSubscriptionValues;
      if (haveDetailsChanged) {
        // Update details (eg. amount, tier)
        const tier = !isNull(args.tier.id) && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));
        const membership =
          !isNull(order) &&
          (await models.Member.findOne({
            where: { MemberCollectiveId: order.FromCollectiveId, CollectiveId: order.CollectiveId, role: 'BACKER' },
          }));
        let newTotalAmount = getValueInCentsFromAmountInput(args.amount);
        // We add the current Platform Tip to the totalAmount
        if (order.data?.isFeesOnTop && order.data.platformFee) {
          newTotalAmount = newTotalAmount + order.data.platformFee;
        }
        // interval, amount, tierId, paymentMethodId
        ({ previousOrderValues, previousSubscriptionValues } = await updateSubscriptionDetails(
          order,
          tier,
          membership,
          newTotalAmount,
        ));
      }

      if (args.paypalSubscriptionId) {
        // Update from PayPal subscription ID
        try {
          return updateSubscriptionWithPaypal(req.remoteUser, order, args.paypalSubscriptionId);
        } catch (error) {
          // Restore original subscription if it was modified
          if (haveDetailsChanged) {
            await updateOrderSubscription(order, previousOrderValues, previousSubscriptionValues);
          }

          throw error;
        }
      } else if (hasPaymentMethodChanged) {
        // Update payment method
        const newPaymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod);
        return updatePaymentMethodForSubscription(req.remoteUser, order, newPaymentMethod);
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
      guestToken: {
        type: GraphQLString,
        description: 'If the order was made as a guest, you can use this field to authenticate',
      },
    },
    async resolve(_, args, req) {
      const baseOrder = await fetchOrderWithReference(args.order);
      const updatedOrder = await confirmOrderLegacy(baseOrder, req.remoteUser, args.guestToken);
      return {
        order: updatedOrder,
        stripeError: updatedOrder.stripeError,
        guestToken: args.guestToken,
      };
    },
  },
  processPendingOrder: {
    type: new GraphQLNonNull(Order),
    description: 'A mutation for the host to approve or reject an order',
    args: {
      order: {
        type: new GraphQLNonNull(OrderUpdateInput),
      },
      action: {
        type: new GraphQLNonNull(ProcessOrderAction),
      },
    },
    async resolve(_, args, req) {
      const order = await fetchOrderWithReference(args.order);
      const toAccount = await req.loaders.Collective.byId.load(order.CollectiveId);

      if (!req.remoteUser?.isAdmin(toAccount.HostCollectiveId)) {
        throw new Unauthorized('Only host admins can process orders');
      }

      if (args.action === 'MARK_AS_PAID') {
        if (!(await canMarkAsPaid(req, order))) {
          throw new ValidationFailed(`Only pending/expired orders can be marked as paid, this one is ${order.status}`);
        }

        const hasAmounts = !isEmpty(difference(keys(args.order), ['id', 'legacyId']));
        if (hasAmounts) {
          const { amount, paymentProcessorFee, platformTip } = args.order;
          if (amount) {
            if (amount.currency !== order.currency) {
              throw new ValidationFailed('Amount currency must match order currency.');
            }
            if (platformTip && platformTip.currency !== order.currency) {
              throw new ValidationFailed('Platform tip currency must match order currency.');
            }

            const amountInCents = getValueInCentsFromAmountInput(amount);
            const platformTipInCents = platformTip ? getValueInCentsFromAmountInput(platformTip) : 0;
            const totalAmount = amountInCents + platformTipInCents;
            order.set('totalAmount', totalAmount);
          }
          if (paymentProcessorFee) {
            if (paymentProcessorFee.currency !== order.currency) {
              throw new ValidationFailed('Payment processor fee currency must match order currency.');
            }
            if (!order.data) {
              order.set('data', {});
            }

            const paymentProcessorFeeInCents = getValueInCentsFromAmountInput(paymentProcessorFee);
            order.set('data.paymentProcessorFee', paymentProcessorFeeInCents);
          }
          if (platformTip) {
            if (platformTip.currency !== order.currency) {
              throw new ValidationFailed('Platform tip currency must match order currency.');
            }
            const platformTipInCents = getValueInCentsFromAmountInput(platformTip);
            if (!order.data) {
              order.set('data', {});
            }
            order.set('data.platformTip', platformTipInCents);
            // Some parts of the order flow still uses data.platformFee
            order.set('data.platformFee', platformTipInCents);
          }
          await order.save();
        }

        return order.markAsPaid(req.remoteUser);
      } else if (args.action === 'MARK_AS_EXPIRED') {
        if (!(await canMarkAsExpired(req, order))) {
          throw new ValidationFailed(`Only pending orders can be marked as expired, this one is ${order.status}`);
        }

        return order.markAsExpired();
      } else {
        throw new BadRequest(`Unknown action ${args.action}`);
      }
    },
  },
  moveOrders: {
    type: new GraphQLNonNull(new GraphQLList(Order)),
    description: 'A mutation for root users to move orders from one account to another',
    args: {
      orders: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrderReferenceInput))),
        description: 'The orders to move',
      },
      fromAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The account to move the orders to',
      },
      makeIncognito: {
        type: GraphQLBoolean,
        description: 'If true, the orders will be moved to the incognito account of "fromAccount"',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser?.isRoot()) {
        throw new Unauthorized('Only root admins can move orders at the moment');
      } else if (!args.orders.length) {
        return [];
      }

      // -- Load everything --
      let fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      if (args.makeIncognito) {
        fromAccount = await fromAccount.getOrCreateIncognitoProfile();
        if (!fromAccount) {
          throw new ValidationFailed('Could not create incognito profile for this account');
        }
      }

      const allOrders = await fetchOrdersWithReferences(args.orders, {
        include: [
          { association: 'paymentMethod' },
          { association: 'fromCollective', attributes: ['id', 'slug'] },
          { association: 'collective', attributes: ['id', 'slug'] },
        ],
      });

      // Filter out orders that do not need to be updated
      const orders = allOrders.filter(order => order.FromCollectiveId !== fromAccount.id);

      // -- Some sanity checks to prevent issues --
      const paymentMethodIds = uniq(orders.map(order => order.PaymentMethodId).filter(Boolean));
      const ordersIds = orders.map(order => order.id);
      for (const order of orders) {
        // Payment method can't be ACCOUNT_BALANCE - we're not ready to transfer these
        if (
          order.paymentMethod &&
          order.paymentMethod.service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE &&
          order.paymentMethod.type === PAYMENT_METHOD_TYPE.COLLECTIVE
        ) {
          throw new ValidationFailed(
            `Order #${order.id} has an unsupported payment method (${order.paymentMethod.service}/${order.paymentMethod.type})`,
          );
        }

        // When moving the payment method for an order, we must make sure it's not used by other orders we're not moving
        const zombieOrders = await models.Order.findAll({
          where: { PaymentMethodId: paymentMethodIds, id: { [Op.notIn]: ordersIds } },
        });

        if (zombieOrders.length) {
          const zombiePaymentMethodsIds = uniq(zombieOrders.map(o => `#${o.PaymentMethodId}`)).join(', ');
          const zombieOrdersIds = zombieOrders.map(o => `#${o.id}`).join(', ');
          throw new ValidationFailed(
            `Can't move selected orders because the payment methods (${zombiePaymentMethodsIds}) are still used by other orders (${zombieOrdersIds})`,
          );
        }
      }

      // -- Move orders --
      const result = await sequelize.transaction(async dbTransaction => {
        // Update transactions
        // ... CREDIT
        const [, updatedCredits] = await models.Transaction.update(
          { FromCollectiveId: fromAccount.id },
          {
            transaction: dbTransaction,
            returning: ['id'],
            where: { [Op.or]: orders.map(order => ({ OrderId: order.id, FromCollectiveId: order.FromCollectiveId })) },
          },
        );

        // ... DEBIT
        const [, updatedDebits] = await models.Transaction.update(
          { CollectiveId: fromAccount.id },
          {
            transaction: dbTransaction,
            returning: ['id'],
            where: { [Op.or]: orders.map(order => ({ OrderId: order.id, CollectiveId: order.FromCollectiveId })) },
          },
        );

        // Update members
        const [, updatedMembers] = await models.Member.update(
          { MemberCollectiveId: fromAccount.id },
          {
            transaction: dbTransaction,
            returning: ['id'],
            where: {
              [Op.or]: orders.map(order => ({
                MemberCollectiveId: order.FromCollectiveId,
                CollectiveId: order.CollectiveId,
                TierId: order.TierId,
                role: roles.BACKER,
              })),
            },
          },
        );

        // Payment methods
        const [, updatedPaymentMethods] = await models.PaymentMethod.update(
          { CollectiveId: fromAccount.id },
          {
            transaction: dbTransaction,
            returning: ['id'],
            where: { id: paymentMethodIds },
          },
        );

        // Update orders
        const [, updatedOrders] = await models.Order.update(
          { FromCollectiveId: fromAccount.id },
          {
            transaction: dbTransaction,
            returning: true,
            where: { id: ordersIds },
          },
        );

        // Log the update
        await models.MigrationLog.create(
          {
            type: MigrationLogType.MOVE_ORDERS,
            description: `Move ${orders.length} orders (@${fromAccount.slug} #${fromAccount.id})`,
            CreatedByUserId: req.remoteUser.id,
            data: {
              orders: updatedOrders.map(o => o.id),
              fromAccount: fromAccount.id,
              paymentMethods: updatedPaymentMethods.map(pm => pm.id),
              members: updatedMembers.map(m => m.id),
              transactions: [...updatedCredits.map(t => t.id), ...updatedDebits.map(t => t.id)],
              previousOrdersValues: mapValues(keyBy(orders, 'id'), order =>
                pick(order, ['FromCollectiveId', 'CollectiveId']),
              ),
            },
          },
          { transaction: dbTransaction },
        );

        return updatedOrders;
      });

      // Purge cache(s)
      const collectivesToPurge = flatten(allOrders.map(order => [order.fromCollective, order.collective]));
      const uniqueCollectivesToPurge = uniqBy(collectivesToPurge, 'id');
      uniqueCollectivesToPurge.forEach(purgeAllCachesForAccount);

      return result;
    },
  },
};

export default orderMutations;
