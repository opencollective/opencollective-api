import config from 'config';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import {
  difference,
  flatten,
  get,
  isEmpty,
  isNil,
  isNull,
  isUndefined,
  keyBy,
  keys,
  mapValues,
  omitBy,
  pick,
  uniq,
  uniqBy,
} from 'lodash';

import { roles } from '../../../constants';
import activities from '../../../constants/activities';
import { types as CollectiveType, types } from '../../../constants/collectives';
import { Service } from '../../../constants/connected_account';
import OrderStatuses from '../../../constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { purgeAllCachesForAccount } from '../../../lib/cache';
import logger from '../../../lib/logger';
import stripe, { convertToStripeAmount } from '../../../lib/stripe';
import {
  updateOrderSubscription,
  updatePaymentMethodForSubscription,
  updateSubscriptionDetails,
} from '../../../lib/subscriptions';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Op, sequelize } from '../../../models';
import { MigrationLogType } from '../../../models/MigrationLog';
import { updateSubscriptionWithPaypal } from '../../../paymentProviders/paypal/subscription';
import { checkRemoteUserCanRoot, checkRemoteUserCanUseOrders, checkScope } from '../../common/scope-check';
import { BadRequest, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { confirmOrder as confirmOrderLegacy, createOrder as createOrderLegacy } from '../../v1/mutations/orders';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { ProcessOrderAction } from '../enum/ProcessOrderAction';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, assertAmountInputCurrency, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { OrderCreateInput, PendingOrderCreateInput, PendingOrderEditInput } from '../input/OrderCreateInput';
import { fetchOrdersWithReferences, fetchOrderWithReference, OrderReferenceInput } from '../input/OrderReferenceInput';
import { OrderUpdateInput } from '../input/OrderUpdateInput';
import PaymentIntentInput from '../input/PaymentIntentInput';
import { getLegacyPaymentMethodFromPaymentMethodInput } from '../input/PaymentMethodInput';
import { fetchPaymentMethodWithReference, PaymentMethodReferenceInput } from '../input/PaymentMethodReferenceInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';
import { canEdit, canMarkAsExpired, canMarkAsPaid } from '../object/OrderPermissions';
import PaymentIntent from '../object/PaymentIntent';
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
    description: 'To submit a new order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(OrderCreateInput),
      },
    },
    async resolve(_, args, req) {
      // Ok for non-authenticated users, we only check scope
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

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
      const expectedCurrency = (tier && tier.currency) || collective.currency;
      const paymentMethod = await getLegacyPaymentMethodFromPaymentMethodInput(order.paymentMethod);
      if (order.paymentMethod?.paymentIntentId) {
        paymentMethod.paymentIntentId = order.paymentMethod?.paymentIntentId;
      }

      // Ensure amounts are provided with the right currency
      ['platformTipAmount', 'amount', 'tax.amount'].forEach(field => {
        const amount = get(order, field);
        if (amount) {
          assertAmountInputCurrency(amount, expectedCurrency, { name: field });
        }
      });

      const legacyOrderObj = {
        quantity: order.quantity,
        amount: getValueInCentsFromAmountInput(order.amount),
        currency: expectedCurrency,
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

      // Check 2FA for non-guest contributions
      if (req.remoteUser) {
        await twoFactorAuthLib.enforceForAccount(req, fromCollective, { onlyAskOnLogin: true });
      }

      const result = await createOrderLegacy(legacyOrderObj, req);
      return { ...pick(result, ['order', 'stripeError']), guestToken: result.order.data?.guestToken };
    },
  },
  cancelOrder: {
    type: Order,
    description: 'Cancel an order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(OrderReferenceInput),
        description: 'Object matching the OrderReferenceInput (id)',
      },
      reason: {
        type: GraphQLString,
        description: 'Reason for cancelling subscription',
      },
      reasonCode: {
        type: GraphQLString,
        description: 'Category for cancelling subscription',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      const order = await fetchOrderWithReference(args.order, {
        throwIfMissing: false,
        include: [
          { association: 'paymentMethod' },
          { model: models.Subscription },
          { model: models.Collective, as: 'collective' },
          { model: models.Collective, as: 'fromCollective' },
        ],
      });

      if (!order) {
        throw new NotFound('Recurring contribution not found');
      }

      if (!req.remoteUser.isAdminOfCollective(order.fromCollective)) {
        throw new Unauthorized("You don't have permission to cancel this recurring contribution");
      } else if (!order.Subscription?.isActive && order.status === OrderStatuses.CANCELLED) {
        throw new Error('Recurring contribution already canceled');
      } else if (order.status === OrderStatuses.PAID) {
        throw new Error('Cannot cancel a paid order');
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, order.fromCollective, { onlyAskOnLogin: true });

      await order.update({ status: OrderStatuses.CANCELLED });
      await order.Subscription.deactivate();

      await models.Activity.create({
        type: activities.SUBSCRIPTION_CANCELED,
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        HostCollectiveId: order.collective.HostCollectiveId,
        OrderId: order.id,
        UserId: order.CreatedByUserId,
        UserTokenId: req.userToken?.id,
        data: {
          subscription: order.Subscription,
          collective: order.collective.minimal,
          user: req.remoteUser.minimal,
          fromCollective: order.fromCollective.minimal,
          reason: args.reason,
          reasonCode: args.reasonCode,
        },
      });

      return order.reload();
    },
  },
  updateOrder: {
    type: Order,
    description: `Update an Order's amount, tier, or payment method. Scope: "orders".`,
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
      checkRemoteUserCanUseOrders(req);

      const decodedId = idDecode(args.order.id, IDENTIFIER_TYPES.ORDER);
      const haveDetailsChanged = !isUndefined(args.amount) || !isUndefined(args.tier);
      const hasPaymentMethodChanged = !isUndefined(args.paymentMethod);

      const order = await models.Order.findOne({
        where: { id: decodedId },
        include: [
          { model: models.Subscription, required: true },
          { association: 'collective', required: true },
          { association: 'fromCollective', required: true },
          { association: 'paymentMethod' },
          { association: 'Tier' },
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

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, order.fromCollective, { onlyAskOnLogin: true });

      let previousOrderValues, previousSubscriptionValues;
      if (haveDetailsChanged) {
        // Update details (eg. amount, tier)
        const tier =
          isNull(args.tier) || args.tier?.isCustom
            ? null
            : args.tier
            ? await fetchTierWithReference(args.tier, { throwIfMissing: true })
            : order.Tier;

        const membership =
          !isNull(order) &&
          (await models.Member.findOne({
            where: { MemberCollectiveId: order.FromCollectiveId, CollectiveId: order.CollectiveId, role: 'BACKER' },
          }));
        const expectedCurrency = order.currency;
        let newTotalAmount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency });
        // We add the current Platform Tip to the totalAmount
        if (order.platformTipAmount) {
          newTotalAmount = newTotalAmount + order.platformTipAmount;
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
    description: 'Confirm an order (strong customer authentication). Scope: "orders".',
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
      // Ok for non-authenticated users, we only check scope
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

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
    description: 'A mutation for the host to approve or reject an order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(OrderUpdateInput),
      },
      action: {
        type: new GraphQLNonNull(ProcessOrderAction),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      let order = await fetchOrderWithReference(args.order);
      const toAccount = await req.loaders.Collective.byId.load(order.CollectiveId);
      const host = await toAccount.getHostCollective();

      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can process orders');
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });

      if (args.action === 'MARK_AS_PAID') {
        if (!(await canMarkAsPaid(req, order))) {
          throw new ValidationFailed(`Only pending/expired orders can be marked as paid, this one is ${order.status}`);
        }

        const hasAmounts = !isEmpty(difference(keys(args.order), ['id', 'legacyId']));
        if (hasAmounts) {
          const { amount, paymentProcessorFee, platformTip, hostFeePercent, processedAt } = args.order;

          // Ensure amounts are provided with the right currency
          ['amount', 'paymentProcessorFee', 'platformTip'].forEach(field => {
            if (!isNil(args.order[field])) {
              assertAmountInputCurrency(args.order[field], order.currency, { name: field });
            }
          });

          if (!isNil(amount)) {
            const amountInCents = getValueInCentsFromAmountInput(amount);
            const platformTipInCents = platformTip ? getValueInCentsFromAmountInput(platformTip) : 0;
            const totalAmount = amountInCents + platformTipInCents;
            order.set('totalAmount', totalAmount);
          }
          if (!isNil(paymentProcessorFee)) {
            if (!order.data) {
              order.set('data', {});
            }

            const paymentProcessorFeeInCents = getValueInCentsFromAmountInput(paymentProcessorFee);
            order.set('data.paymentProcessorFee', paymentProcessorFeeInCents);
          }
          if (!isNil(platformTip)) {
            const platformTipInCents = getValueInCentsFromAmountInput(platformTip);
            order.set('platformTipAmount', platformTipInCents);
          }
          if (!isNil(hostFeePercent)) {
            order.set('data.hostFeePercent', hostFeePercent);
          }

          if (!isNil(processedAt)) {
            order.set('processedAt', processedAt);
          }
          await order.save();
        }

        order = await order.markAsPaid(req.remoteUser);

        if (order.data.isPendingContribution) {
          const tier = order.TierId && (await req.loaders.Tier.byId.load(order.TierId));
          const fromAccount = await req.loaders.Collective.byId.load(order.FromCollectiveId);
          await models.Activity.create({
            type: activities.ORDER_PENDING_RECEIVED,
            UserId: req.remoteUser.id,
            CollectiveId: order.CollectiveId,
            FromCollectiveId: order.FromCollectiveId,
            OrderId: order.id,
            HostCollectiveId: host.id,
            data: {
              order: { ...order.info, ...pick(order.data, ['expectedAt', 'memo']) },
              fromAccountInfo: order.data.fromAccountInfo,
              fromCollective: fromAccount.info,
              host: host.info,
              toCollective: toAccount.info,
              tierName: tier?.name,
            },
          });
        }

        return order;
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
    description: '[Root only] A mutation to move orders from one account to another',
    args: {
      orders: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrderReferenceInput))),
        description: 'The orders to move',
      },
      fromAccount: {
        type: AccountReferenceInput,
        description: 'The account to move the orders to. Set to null to keep existing',
      },
      tier: {
        type: TierReferenceInput,
        description:
          'The tier to move the orders to. Set to null to keep existing. Pass { id: "custom" } to reference the custom tier (/donate)',
      },
      makeIncognito: {
        type: GraphQLBoolean,
        description: 'If true, the orders will be moved to the incognito account of "fromAccount"',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      if (!args.orders.length) {
        return [];
      } else if (!args.fromAccount && !args.tier) {
        throw new ValidationFailed('You must specify a "fromAccount" or a "tier" for the update');
      }

      // -- Load everything --
      let fromAccount, tier;
      if (args.fromAccount) {
        fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
        if (args.makeIncognito) {
          fromAccount = await fromAccount.getOrCreateIncognitoProfile();
          if (!fromAccount) {
            throw new ValidationFailed('Could not create incognito profile for this account');
          }
        }
      } else if (args.makeIncognito) {
        throw new ValidationFailed('Not supported: Cannot make orders incognito if no account is specified');
      }

      if (args.tier) {
        tier = await fetchTierWithReference(args.tier, { throwIfMissing: true, allowCustomTier: true });
      }

      const orders = await fetchOrdersWithReferences(args.orders, {
        include: [
          { association: 'paymentMethod' },
          { association: 'fromCollective', attributes: ['id', 'slug'] },
          { association: 'collective', attributes: ['id', 'slug', 'HostCollectiveId'] },
        ],
      });

      // -- Some sanity checks to prevent issues --
      const isAddedFund = order =>
        order.paymentMethod?.service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE &&
        order.paymentMethod.type === PAYMENT_METHOD_TYPE.HOST;
      const paymentMethodIds = uniq(
        orders
          .filter(order => !isAddedFund(order))
          .map(order => order.PaymentMethodId)
          .filter(Boolean),
      );
      const ordersIds = orders.map(order => order.id);
      const addedFundOrders = orders.filter(order => isAddedFund(order));
      const isUser = fromAccount?.type === types.USER;
      const addedFundPaymentMethod = fromAccount
        ? await models.PaymentMethod.findOne({
            where: {
              CollectiveId: fromAccount.id,
              service: 'opencollective',
              type: 'collective',
              deletedAt: null,
            },
          })
        : null;

      for (const order of orders) {
        if (fromAccount) {
          if (
            fromAccount.HostCollectiveId !== order.collective.HostCollectiveId &&
            fromAccount.type !== CollectiveType.USER
          ) {
            throw new ValidationFailed(`Added Funds cannot be moved to a different host`);
          }
        }

        const isUpdatingPaymentMethod = Boolean(fromAccount);

        if (isUpdatingPaymentMethod && !isAddedFund(order)) {
          // Payment method can't be ACCOUNT_BALANCE - we're not ready to transfer these
          if (order.paymentMethod?.service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE) {
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

        // Can't move to another collective tier
        if (tier && tier !== 'custom' && orders.some(o => o.CollectiveId !== tier.CollectiveId)) {
          throw new ValidationFailed(`Can't move orders to a different collective tier`);
        }
      }

      // -- Move orders --
      const result = await sequelize.transaction(async dbTransaction => {
        let updatedPaymentMethods = [],
          updatedCredits = [],
          updatedDebits = [];

        if (fromAccount) {
          // Payment methods
          [, updatedPaymentMethods] = await models.PaymentMethod.update(
            { CollectiveId: fromAccount.id },
            {
              transaction: dbTransaction,
              returning: ['id'],
              where: { id: paymentMethodIds },
            },
          );

          // Update transactions
          [, updatedCredits] = await models.Transaction.update(
            { FromCollectiveId: fromAccount.id },
            {
              transaction: dbTransaction,
              returning: ['id'],
              where: {
                [Op.or]: orders.map(order => ({ OrderId: order.id, FromCollectiveId: order.FromCollectiveId })),
              },
            },
          );

          [, updatedDebits] = await models.Transaction.update(
            { CollectiveId: fromAccount.id },
            {
              transaction: dbTransaction,
              returning: ['id'],
              where: {
                [Op.or]: orders.map(order => ({ OrderId: order.id, CollectiveId: order.FromCollectiveId })),
              },
            },
          );

          // Update paymentMethodId in transactions for Added Funds
          if (addedFundOrders.length > 0 && !isUser) {
            await models.Transaction.update(
              { PaymentMethodId: addedFundPaymentMethod.id },
              {
                transaction: dbTransaction,
                where: {
                  [Op.or]: addedFundOrders.map(order => ({ OrderId: order.id })),
                },
              },
            );
          }
        }

        // Update members
        const membersPayload = {};
        if (fromAccount) {
          membersPayload['MemberCollectiveId'] = fromAccount.id;
        }
        if (tier) {
          membersPayload['TierId'] = tier === 'custom' ? null : tier.id;
        }
        const [, updatedMembers] = await models.Member.update(membersPayload, {
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
        });

        // Update orders
        const ordersPayload = {};
        if (fromAccount) {
          ordersPayload['FromCollectiveId'] = fromAccount.id;
        }
        if (tier) {
          ordersPayload['TierId'] = tier === 'custom' ? null : tier.id;
        }

        const [, updatedOrders] = await models.Order.update(ordersPayload, {
          transaction: dbTransaction,
          returning: true,
          where: { id: ordersIds },
        });

        if (addedFundOrders.length > 0 && !isUser && addedFundPaymentMethod) {
          await models.Order.update(
            { PaymentMethodId: addedFundPaymentMethod.id },
            {
              transaction: dbTransaction,
              returning: true,
              where: { [Op.or]: addedFundOrders.map(order => ({ id: order.id })) },
            },
          );
        }

        // Log the update
        const descriptionDetails = [];
        if (fromAccount) {
          descriptionDetails.push(`@${fromAccount.slug}`);
        }
        if (tier) {
          descriptionDetails.push(tier === 'custom' ? 'custom tier' : `tier #${tier.id}`);
        }

        await models.MigrationLog.create(
          {
            type: MigrationLogType.MOVE_ORDERS,
            description: `Move ${orders.length} orders${
              descriptionDetails ? ` (${descriptionDetails.join(', ')})` : ''
            }`,
            CreatedByUserId: req.remoteUser.id,
            data: {
              orders: updatedOrders.map(o => o.id),
              fromAccount: fromAccount?.id,
              tier: tier?.id,
              paymentMethods: updatedPaymentMethods.map(pm => pm.id),
              members: updatedMembers.map(m => m.id),
              transactions: [...updatedCredits.map(t => t.id), ...updatedDebits.map(t => t.id)],
              previousOrdersValues: mapValues(keyBy(orders, 'id'), order =>
                pick(order, ['FromCollectiveId', 'CollectiveId', 'TierId']),
              ),
            },
          },
          { transaction: dbTransaction },
        );

        return updatedOrders;
      });

      // Purge cache(s)
      const collectivesToPurge = flatten(orders.map(order => [order.fromCollective, order.collective]));
      const uniqueCollectivesToPurge = uniqBy(collectivesToPurge, 'id');
      uniqueCollectivesToPurge.forEach(purgeAllCachesForAccount);

      return result;
    },
  },
  createPaymentIntent: {
    type: new GraphQLNonNull(PaymentIntent),
    description: 'Creates a Stripe payment intent',
    args: {
      paymentIntent: {
        type: new GraphQLNonNull(PaymentIntentInput),
      },
    },
    async resolve(_, args, req) {
      const paymentIntentInput = args.paymentIntent;

      const toAccount = await fetchAccountWithReference(paymentIntentInput.toAccount, { throwIfMissing: true });
      const hostStripeAccount = await toAccount.getHostStripeAccount();

      const isPlatformHost = hostStripeAccount.username === config.stripe.accountId;

      let stripeCustomerId;
      let fromAccount;
      if (req.remoteUser) {
        fromAccount =
          paymentIntentInput.fromAccount &&
          (await fetchAccountWithReference(paymentIntentInput.fromAccount, { throwIfMissing: true }));

        if (!req.remoteUser.isAdminOfCollective(fromAccount)) {
          throw new Unauthorized();
        }

        let stripeCustomerAccount = await fromAccount.getCustomerStripeAccount(hostStripeAccount.username);

        if (!stripeCustomerAccount) {
          const customer = await stripe.customers.create(
            {
              email: req.remoteUser.email,
              description: `${config.host.website}/${fromAccount.slug}`,
            },
            !isPlatformHost
              ? {
                  stripeAccount: hostStripeAccount.username,
                }
              : undefined,
          );

          stripeCustomerAccount = await models.ConnectedAccount.create({
            clientId: hostStripeAccount.username,
            username: customer.id,
            CollectiveId: fromAccount.id,
            service: Service.STRIPE_CUSTOMER,
          });
        }

        stripeCustomerId = stripeCustomerAccount.username;
      }

      const totalOrderAmount = getValueInCentsFromAmountInput(paymentIntentInput.amount);

      const currency = paymentIntentInput.currency;

      try {
        const paymentIntent = await stripe.paymentIntents.create(
          {
            customer: stripeCustomerId,
            description: `Contribution to ${toAccount.name}`,
            amount: convertToStripeAmount(currency, totalOrderAmount),
            currency: paymentIntentInput.amount.currency.toLowerCase(),
            // eslint-disable-next-line camelcase
            automatic_payment_methods: { enabled: true },
            metadata: {
              from: fromAccount ? `${config.host.website}/${fromAccount.slug}` : undefined,
              to: `${config.host.website}/${toAccount.slug}`,
            },
          },
          !isPlatformHost
            ? {
                stripeAccount: hostStripeAccount.username,
              }
            : undefined,
        );

        return {
          id: paymentIntent.id,
          paymentIntentClientSecret: paymentIntent.client_secret,
          stripeAccount: hostStripeAccount.username,
          stripeAccountPublishableSecret: hostStripeAccount.data.publishableKey,
        };
      } catch (e) {
        logger.error(e);
        throw new Error('Sorry, but we cannot support this payment method for this particular transaction.');
      }
    },
  },
  createPendingOrder: {
    type: new GraphQLNonNull(Order),
    description: 'To submit a new order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(PendingOrderCreateInput),
      },
    },
    async resolve(_, args, req) {
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

      const toAccount = await fetchAccountWithReference(args.order.toAccount, { throwIfMissing: true });
      const host = await toAccount.getHostCollective();

      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can process orders');
      }
      const fromAccount = await fetchAccountWithReference(args.order.fromAccount, { throwIfMissing: true });

      const orderProps = {
        CreatedByUserId: req.remoteUser.id,
        FromCollectiveId: fromAccount.id,
        CollectiveId: toAccount.id,
        quantity: 1,
        totalAmount: getValueInCentsFromAmountInput(args.order.amount),
        currency: args.order.amount.currency,
        description: args.order.description || models.Order.generateDescription(toAccount, undefined, undefined),
        data: {
          fromAccountInfo: args.order.fromAccountInfo,
          expectedAt: args.order.expectedAt,
          ponumber: args.order.ponumber,
          memo: args.order.memo,
          paymentMethod: args.order.paymentMethod,
          isPendingContribution: true,
          hostFeePercent: args.order?.hostFeePercent,
        },
        status: OrderStatuses.PENDING,
      };

      const tier = args.order.tier && (await fetchTierWithReference(args.order.tier, { throwIfMissing: true }));
      if (tier) {
        if (!args.order.description) {
          orderProps.description = models.Order.generateDescription(toAccount, undefined, undefined, tier);
        }
        orderProps.TierId = tier.id;
      }

      const order = await models.Order.create(orderProps);

      await models.Activity.create({
        type: activities.ORDER_PENDING_CREATED,
        UserId: req.remoteUser.id,
        CollectiveId: toAccount.id,
        FromCollectiveId: fromAccount.id,
        OrderId: order.id,
        HostCollectiveId: host.id,
        data: {
          order: { ...order.info, ...pick(orderProps.data, ['expectedAt', 'memo']) },
          fromAccountInfo: orderProps.data.fromAccountInfo,
          fromCollective: fromAccount.info,
          host: host.info,
          toCollective: toAccount.info,
          tierName: tier?.name,
        },
      });

      return order;
    },
  },
  editPendingOrder: {
    type: new GraphQLNonNull(Order),
    description: 'To edit a pending order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(PendingOrderEditInput),
      },
    },
    async resolve(_, args, req) {
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

      const order = await fetchOrderWithReference(args.order, {
        throwIfMissing: true,
        include: [{ model: models.Collective, as: 'collective' }],
      });

      const host = await order.collective.getHostCollective();
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can process orders');
      }

      if (!(await canEdit(req, order))) {
        throw new ValidationFailed(`Only pending orders can be edited, this one is ${order.status}`);
      }

      const fromAccount = await fetchAccountWithReference(args.order.fromAccount);

      await order.update({
        FromCollectiveId: fromAccount?.id || undefined,
        totalAmount: getValueInCentsFromAmountInput(args.order.amount),
        currency: args.order.amount.currency,
        description: args.order.description,
        data: {
          ...order.data,
          ...omitBy(
            {
              ponumber: args.order.ponumber,
              memo: args.order.memo,
              paymentMethod: args.order.paymentMethod,
              fromAccountInfo: args.order.fromAccountInfo,
              expectedAt: args.order.expectedAt,
              isPendingContribution: true,
              hostFeePercent: args.order?.hostFeePercent,
            },
            isUndefined,
          ),
        },
        status: OrderStatuses.PENDING,
      });

      return order;
    },
  },
};

export default orderMutations;
