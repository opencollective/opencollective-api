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
import { CollectiveType } from '../../../constants/collectives';
import { Service } from '../../../constants/connected-account';
import FEATURE from '../../../constants/feature';
import OrderStatuses from '../../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { purgeAllCachesForAccount } from '../../../lib/cache';
import { checkCaptcha } from '../../../lib/check-captcha';
import logger from '../../../lib/logger';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../../../lib/sanitize-html';
import { checkGuestContribution, checkOrdersLimit } from '../../../lib/security/limit';
import { orderFraudProtection } from '../../../lib/security/order';
import { reportErrorToSentry } from '../../../lib/sentry';
import stripe, { convertToStripeAmount, sanitizeStripeError } from '../../../lib/stripe';
import {
  updateOrderSubscription,
  updatePaymentMethodForSubscription,
  updateSubscriptionDetails,
} from '../../../lib/subscriptions';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { canUseFeature } from '../../../lib/user-permissions';
import models, { Op, sequelize } from '../../../models';
import { MigrationLogType } from '../../../models/MigrationLog';
import { updateSubscriptionWithPaypal } from '../../../paymentProviders/paypal/subscription';
import { checkReceiveFinancialContributions } from '../../common/features';
import * as OrdersLib from '../../common/orders';
import { checkRemoteUserCanRoot, checkRemoteUserCanUseOrders, checkScope } from '../../common/scope-check';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../../errors';
import {
  confirmOrder as confirmOrderLegacy,
  createOrder as createOrderLegacy,
  getOrderTaxInfoFromTaxInput,
} from '../../v1/mutations/orders';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { GraphQLProcessOrderAction } from '../enum/ProcessOrderAction';
import { TierFrequencyKey } from '../enum/TierFrequency';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import {
  fetchAccountingCategoryWithReference,
  GraphQLAccountingCategoryReferenceInput,
} from '../input/AccountingCategoryInput';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { assertAmountInputCurrency, getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import { GraphQLGuestInfoInput } from '../input/GuestInfoInput';
import {
  GraphQLOrderCreateInput,
  GraphQLPendingOrderCreateInput,
  GraphQLPendingOrderEditInput,
} from '../input/OrderCreateInput';
import {
  fetchOrdersWithReferences,
  fetchOrderWithReference,
  GraphQLOrderReferenceInput,
} from '../input/OrderReferenceInput';
import { GraphQLOrderUpdateInput } from '../input/OrderUpdateInput';
import GraphQLPaymentIntentInput from '../input/PaymentIntentInput';
import { getLegacyPaymentMethodFromPaymentMethodInput } from '../input/PaymentMethodInput';
import {
  fetchPaymentMethodWithReference,
  GraphQLPaymentMethodReferenceInput,
} from '../input/PaymentMethodReferenceInput';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';
import { fetchTransactionsImportRowWithReference } from '../input/TransactionsImportRowReferenceInput';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLOrder } from '../object/Order';
import GraphQLPaymentIntent from '../object/PaymentIntent';
import { GraphQLStripeError } from '../object/StripeError';

const GraphQLOrderWithPayment = new GraphQLObjectType({
  name: 'OrderWithPayment',
  fields: () => ({
    order: {
      type: new GraphQLNonNull(GraphQLOrder),
      description: 'The order created',
    },
    guestToken: {
      type: GraphQLString,
      description: 'If donating as a guest, this will contain your guest token to confirm your order',
    },
    stripeError: {
      type: GraphQLStripeError,
      description:
        'This field will be set if the order was created but there was an error with Stripe during the payment',
    },
  }),
});

const getTaxAmount = (baseAmount, tax) => {
  if (tax) {
    if (tax.amount) {
      return getValueInCentsFromAmountInput(tax.amount);
    } else if (tax.rate) {
      return Math.round(tax.rate * baseAmount);
    } else if (tax.percentage) {
      return Math.round((tax.percentage / 100) * baseAmount);
    }
  }

  return 0;
};

/**
 * Computes the total amount for an order
 * @param {number} baseAmount
 * @param {number} platformTipAmount
 * @param {OrderTaxInput | TaxInput | OrderTax} taxInput
 */
const getTotalAmountForOrderInput = (baseAmount, platformTipAmount, tax) => {
  if (tax) {
    baseAmount += getTaxAmount(baseAmount, tax);
  }

  if (platformTipAmount) {
    baseAmount += platformTipAmount;
  }

  return baseAmount;
};

const getOrderBaseAmount = order => {
  return order.totalAmount - (order.taxAmount || 0) - (order.platformTipAmount || 0);
};

/**
 * A wrapper around `getOrderTaxInfoFromTaxInput` that will throw if the tax amount doesn't match the tax percentage.
 */
const getOrderTaxInfo = (taxInput, quantity, orderAmount, fromAccount, toAccount, host) => {
  let taxInfo, taxAmount;
  if (taxInput) {
    const grossAmount = quantity * getValueInCentsFromAmountInput(orderAmount);
    taxInfo = getOrderTaxInfoFromTaxInput(taxInput, fromAccount, toAccount, host);
    taxAmount = getTaxAmount(grossAmount, taxInput);
    const taxAmountFromInput = taxInput.amount && getValueInCentsFromAmountInput(taxInput.amount);
    if (taxInfo.percentage && taxAmountFromInput) {
      const amountDiff = Math.abs(taxAmountFromInput - taxAmount);
      if (amountDiff > 1) {
        // We tolerate a diff by 1 cent to account for rounding. Example: with a contribution of 12$, 15% tax, the gross amount
        // is $10.43 and the tax amount could be rounded either to $1.56 (14.95%) or $1.57 (15.05%). When that happens, the most important
        // is to make sure that we respect the total amount of the order.
        throw new Error(`Tax amount doesn't match tax percentage. Expected ${taxAmount}, got ${taxAmountFromInput}`);
      }
    }
  }

  return { taxInfo, taxAmount };
};

const orderMutations = {
  createOrder: {
    type: new GraphQLNonNull(GraphQLOrderWithPayment),
    description: 'To submit a new order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderCreateInput),
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

      const { order } = args;
      const tax = order.tax || order.taxes?.[0];
      const platformTip = order.platformTipAmount;
      const platformTipAmount = platformTip ? getValueInCentsFromAmountInput(platformTip) : 0;
      const loadersParams = { loaders: req.loaders, throwIfMissing: true };
      const loadAccount = account => fetchAccountWithReference(account, loadersParams);
      const tier = order.tier && (await fetchTierWithReference(order.tier, loadersParams));
      const fromCollective = order.fromAccount && (await loadAccount(order.fromAccount));
      const collective = await loadAccount(order.toAccount);
      const expectedCurrency = (tier && tier.currency) || collective.currency;

      let paymentMethod;
      if (order.isBalanceTransfer && !order.paymentMethod) {
        const internalTransferPaymentMethod = await fromCollective.getOrCreateInternalPaymentMethod();
        paymentMethod = internalTransferPaymentMethod;
      } else {
        paymentMethod = await getLegacyPaymentMethodFromPaymentMethodInput(order.paymentMethod);
      }

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

      const amountInCents = getValueInCentsFromAmountInput(order.amount);
      const quantity = order.quantity || 1;
      const legacyOrderObj = {
        quantity,
        amount: amountInCents,
        currency: expectedCurrency,
        interval: getIntervalFromContributionFrequency(order.frequency),
        taxAmount: tax && getValueInCentsFromAmountInput(tax.amount),
        tax: tax,
        paymentMethod,
        fromCollective: fromCollective && { id: fromCollective.id },
        fromAccountInfo: order.fromAccountInfo,
        collective: { id: collective.id },
        totalAmount: getTotalAmountForOrderInput(amountInCents * quantity, platformTipAmount, tax),
        data: order.data, // We're filtering data before saving it (see `ORDER_PUBLIC_DATA_FIELDS`)
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
        const isUsingBalance = paymentMethod?.service === 'opencollective' && paymentMethod?.type === 'collective';
        // This covers the case where the user is transfering balance between their own collectives
        const isCollectiveRelated =
          fromCollective?.id === collective.ParentCollectiveId || fromCollective?.ParentCollectiveId === collective.id;
        const onlyAskOnLogin = isUsingBalance && !isCollectiveRelated ? false : true;
        await twoFactorAuthLib.enforceForAccount(req, fromCollective, { onlyAskOnLogin });
      }

      const result = await createOrderLegacy(legacyOrderObj, req);
      return { ...pick(result, ['order', 'stripeError']), guestToken: result.order.data?.guestToken };
    },
  },
  cancelOrder: {
    type: GraphQLOrder,
    description: 'Cancel an order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderReferenceInput),
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
          { model: models.Tier, as: 'Tier', required: false },
        ],
      });

      if (!order) {
        throw new NotFound('Recurring contribution not found');
      }

      if (!req.remoteUser.isAdminOfCollective(order.fromCollective) && !req.remoteUser.isRoot()) {
        throw new Unauthorized("You don't have permission to cancel this recurring contribution");
      } else if (!order.Subscription?.isActive && order.status === OrderStatuses.CANCELLED) {
        throw new Error('Recurring contribution already canceled');
      } else if (order.status === OrderStatuses.PAID) {
        throw new Error('Cannot cancel a paid order');
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, order.fromCollective, { onlyAskOnLogin: true });

      const previousStatus = order.status;
      await order.update({ status: OrderStatuses.CANCELLED, data: { ...order.data, previousStatus } });
      if (order.Subscription?.isActive) {
        await order.Subscription.deactivate();
      }

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
          order: order.info,
          tier: order.Tier?.info,
          previousStatus,
        },
      });

      return order.reload();
    },
  },
  updateOrder: {
    type: GraphQLOrder,
    description: `Update an Order's amount, tier, or payment method. Scope: "orders".`,
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderReferenceInput),
        description: 'Reference to the Order to update',
      },
      paymentMethod: {
        type: GraphQLPaymentMethodReferenceInput,
        description: 'Reference to a Payment Method to update the order with',
      },
      paypalSubscriptionId: {
        type: GraphQLString,
        description: 'To update the order with a PayPal subscription',
      },
      tier: {
        type: GraphQLTierReferenceInput,
        description: 'Reference to a Tier to update the order with',
      },
      amount: {
        type: GraphQLAmountInput,
        description: 'An Amount to update the order to',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      const decodedId = idDecode(args.order.id, IDENTIFIER_TYPES.ORDER);
      const haveDetailsChanged = !isUndefined(args.amount) || !isUndefined(args.tier);
      const hasPaymentMethodChanged = !isUndefined(args.paymentMethod) || Boolean(args.paypalSubscriptionId);

      let order = await models.Order.findOne({
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
      } else if (!req.remoteUser.isAdminOfCollective(order.fromCollective) && !req.remoteUser.isRoot()) {
        throw new Unauthorized("You don't have permission to update this order");
      } else if (!order.Subscription.isActive && order.status !== OrderStatuses.PAUSED) {
        throw new Error('Order must be active to be updated');
      } else if (args.paypalSubscriptionId && args.paymentMethod) {
        throw new Error('paypalSubscriptionId and paymentMethod are mutually exclusive');
      } else if (haveDetailsChanged && !isUndefined(args.paymentMethod)) {
        // For non-paypal contributions, there's no transaction/rollback strategy if updating the payment method fails
        // after updating the order. We could end up with partially migrated subscriptions
        // if we allow changing both at the same time.
        throw new Error(
          'Amount and payment method cannot be updated at the same time, please update one after the other',
        );
      } else if (order.status === OrderStatuses.PAUSED) {
        if (order.data?.needsAsyncDeactivation || order.data?.needsAsyncPause || order.data?.needsAsyncReactivation) {
          throw new Error('This order is currently being synchronized, please try again later');
        } else if (!['AVAILABLE', 'ACTIVE'].includes(await checkReceiveFinancialContributions(order.collective, req))) {
          throw new Error(
            'This order cannot be updated because the collective is not able to receive financial contributions',
          );
        }
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, order.fromCollective, { onlyAskOnLogin: true });

      let previousOrderValues, previousSubscriptionValues;

      // Update details (eg. amount, tier)
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

      if (hasPaymentMethodChanged) {
        const previousOrderStatus = order.status;
        if (args.paypalSubscriptionId) {
          // Update from PayPal subscription ID
          try {
            order = await updateSubscriptionWithPaypal(req.remoteUser, order, args.paypalSubscriptionId);
          } catch (error) {
            // Restore original subscription if it was modified
            if (haveDetailsChanged) {
              await updateOrderSubscription(order, previousOrderValues, previousSubscriptionValues);
            }

            throw error;
          }
        } else {
          // Update payment method
          const newPaymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod);
          order = await updatePaymentMethodForSubscription(req.remoteUser, order, newPaymentMethod);
        }

        // Create resume activity if the order was previously paused
        if (previousOrderStatus === OrderStatuses.PAUSED) {
          try {
            await order.createResumeActivity(req.remoteUser, { UserTokenId: req.userToken?.id });
          } catch (error) {
            reportErrorToSentry(error, { req });
          }
        }
      }

      return order;
    },
  },
  updateOrderAccountingCategory: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'Update the accounting category of an order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderReferenceInput),
        description: 'Reference to the Order to update',
      },
      accountingCategory: {
        type: GraphQLAccountingCategoryReferenceInput,
        description: 'Reference to the Accounting Category to update the order with',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      // Load order
      const order = await fetchOrderWithReference(args.order, {
        throwIfMissing: true,
        include: [
          { association: 'collective', required: true, include: [{ association: 'host', required: true }] },
          { association: 'accountingCategory', required: false },
        ],
      });
      if (!req.remoteUser.isAdmin(order.collective.HostCollectiveId)) {
        throw new Unauthorized('Only host admins can update the accounting category of an order');
      } else if (!order.collective.isActive) {
        throw new ValidationFailed('The collective is not active');
      }

      // Load accounting category
      let newAccountingCategory = null;
      if (args.accountingCategory === undefined) {
        throw new ValidationFailed('accountingCategory is required');
      } else if (args.accountingCategory) {
        newAccountingCategory = await fetchAccountingCategoryWithReference(args.accountingCategory, {
          throwIfMissing: true,
        });
      }

      // Check validity
      OrdersLib.checkCanUseAccountingCategoryForOrder(newAccountingCategory, order.collective.host, order.collective);

      // Trigger update
      const previousAccountingCategory = order.accountingCategory;
      if (previousAccountingCategory?.id !== newAccountingCategory?.id) {
        await order.update({ AccountingCategoryId: newAccountingCategory?.id || null });
        await models.Activity.create({
          type: activities.ORDER_UPDATED,
          UserId: req.remoteUser.id,
          CollectiveId: order.CollectiveId,
          FromCollectiveId: req.remoteUser.CollectiveId,
          OrderId: order.id,
          HostCollectiveId: order.collective.HostCollectiveId,
          data: {
            previousData: { accountingCategory: previousAccountingCategory?.publicInfo || null },
            newData: { accountingCategory: newAccountingCategory?.publicInfo || null },
          },
        });
      }

      return order;
    },
  },
  confirmOrder: {
    type: new GraphQLNonNull(GraphQLOrderWithPayment),
    description: 'Confirm an order (strong customer authentication). Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderReferenceInput),
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
        stripeError: sanitizeStripeError(updatedOrder.stripeError),
        guestToken: args.guestToken,
      };
    },
  },
  processPendingOrder: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'A mutation for the host to approve or reject an order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderUpdateInput),
        description: 'The order to process',
      },
      action: {
        type: new GraphQLNonNull(GraphQLProcessOrderAction),
        description: 'The action to take on the order',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      let order = await fetchOrderWithReference(args.order);
      const fromAccount = await req.loaders.Collective.byId.load(order.FromCollectiveId);
      const toAccount = await req.loaders.Collective.byId.load(order.CollectiveId);
      if (toAccount.deactivatedAt) {
        throw new ValidationFailed(`${toAccount.name} has been archived`);
      }

      const host = await toAccount.getHostCollective({ loaders: req.loaders });

      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can process pending contributions');
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });

      if (args.action === 'MARK_AS_PAID') {
        if (!(await OrdersLib.canMarkAsPaid(req, order))) {
          throw new ValidationFailed(
            `Only pending/expired contributions can be marked as paid, this one is ${order.status}`,
          );
        }

        const hasChanges = !isEmpty(difference(keys(args.order), ['id', 'legacyId']));
        if (hasChanges) {
          const { amount, paymentProcessorFee, platformTip, hostFeePercent, processedAt, tax } = args.order;

          // Ensure amounts are provided with the right currency
          ['amount', 'paymentProcessorFee', 'platformTip', 'tax.amount'].forEach(field => {
            if (!isNil(get(args.order, field))) {
              assertAmountInputCurrency(get(args.order, field), order.currency, { name: field });
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
          if (!isNil(tax)) {
            const quantity = 1; // Not supported yet by OrderUpdateInput
            const { taxInfo, taxAmount } = getOrderTaxInfo(
              args.order.tax,
              quantity,
              args.order.amount,
              fromAccount,
              toAccount,
              host,
            );
            order.set('taxAmount', taxAmount);
            order.set('data.tax', taxInfo);
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

          // Re-compute total amount
          const baseAmount = !isNil(args.order.amount)
            ? getValueInCentsFromAmountInput(args.order.amount)
            : getOrderBaseAmount(order);
          order.set(
            'totalAmount',
            getTotalAmountForOrderInput(baseAmount, order.platformTipAmount, args.order.tax || order.data?.tax),
          );

          // Link transactions import row
          let transactionsImportRow;
          if (args.order.transactionsImportRow) {
            transactionsImportRow = await fetchTransactionsImportRowWithReference(args.order.transactionsImportRow, {
              throwIfMissing: true,
            });
            if (transactionsImportRow.isProcessed()) {
              throw new ValidationFailed('This import row has already been processed');
            }

            const transactionsImport = await transactionsImportRow.getImport();
            if (!transactionsImport) {
              throw new NotFound('TransactionsImport not found');
            } else if (transactionsImport.CollectiveId !== host.id) {
              throw new ValidationFailed('This import does not belong to the host');
            }
          }

          await sequelize.transaction(async transaction => {
            await order.save({ transaction });
            if (transactionsImportRow) {
              await transactionsImportRow.update({ OrderId: order.id, status: 'LINKED' }, { transaction });
            }
          });
        }

        order = await order.markAsPaid(req.remoteUser);

        const tier = order.TierId && (await req.loaders.Tier.byId.load(order.TierId));
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
            isPendingContribution: order.data.isPendingContribution,
          },
        });

        return order;
      } else if (args.action === 'MARK_AS_EXPIRED') {
        if (!(await OrdersLib.canMarkAsExpired(req, order))) {
          throw new ValidationFailed(
            `Only pending contributions can be marked as expired, this one is ${order.status}`,
          );
        }

        return order.markAsExpired(req.remoteUser);
      } else {
        throw new BadRequest(`Unknown action ${args.action}`);
      }
    },
  },
  moveOrders: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLOrder)),
    description: '[Root only] A mutation to move orders from one account to another',
    args: {
      orders: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLOrderReferenceInput))),
        description: 'The orders to move',
      },
      fromAccount: {
        type: GraphQLAccountReferenceInput,
        description: 'The account to move the orders to. Set to null to keep existing',
      },
      tier: {
        type: GraphQLTierReferenceInput,
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
        if (args.tier.isCustom) {
          tier = 'custom';
        } else {
          tier = await fetchTierWithReference(args.tier, { throwIfMissing: true });
        }
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

      for (const order of orders) {
        if (fromAccount) {
          if (isAddedFund(order)) {
            if (get(order, 'fromCollective.HostCollectiveId', null) !== get(fromAccount, 'HostCollectiveId', null)) {
              throw new ValidationFailed(
                `Moving Added Funds when the current source Account has a different Fiscal Host than the new source Account is not supported.`,
              );
            }
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
              descriptionDetails.length > 0 ? ` (${descriptionDetails.join(', ')})` : ''
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
    type: new GraphQLNonNull(GraphQLPaymentIntent),
    description: 'Creates a Stripe payment intent',
    args: {
      paymentIntent: {
        type: new GraphQLNonNull(GraphQLPaymentIntentInput),
      },
      guestInfo: {
        type: GraphQLGuestInfoInput,
      },
    },
    async resolve(_, args, req) {
      if (req.remoteUser && !canUseFeature(req.remoteUser, FEATURE.ORDER)) {
        throw new FeatureNotAllowedForUser();
      }

      const paymentIntentInput = args.paymentIntent;

      const toAccount = await fetchAccountWithReference(paymentIntentInput.toAccount, { throwIfMissing: true });
      const hostStripeAccount = await toAccount.getHostStripeAccount();
      if (
        !['ACTIVE', 'AVAILABLE'].includes(
          await checkReceiveFinancialContributions(toAccount, req, { ignoreActive: true }),
        )
      ) {
        throw new Forbidden('This collective cannot receive financial contributions');
      }

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
      } else {
        await checkGuestContribution(
          {
            collective: toAccount,
            fromCollective: fromAccount,
            guestInfo: args.guestInfo,
          },
          req.loaders,
        );

        try {
          await checkCaptcha(args.guestInfo?.captcha, req.ip);
        } catch (err) {
          throw new BadRequest(err.message, undefined, args.guestInfo?.captcha);
        }
      }

      await checkOrdersLimit(
        {
          user: req.remoteUser,
          collective: toAccount,
          fromCollective: fromAccount,
          guestInfo: args.guestInfo,
        },
        req.ip,
        req.mask,
      );
      await orderFraudProtection(req, {
        guestInfo: args.guestInfo,
      }).catch(error => {
        reportErrorToSentry(error, { transactionName: 'orderFraudProtection', user: req.remoteUser });
        throw new ValidationFailed(
          "There's something wrong with the payment, please contact support@opencollective.com.",
          undefined,
          { includeId: true },
        );
      });

      const totalOrderAmount = getValueInCentsFromAmountInput(paymentIntentInput.amount);

      const currency = paymentIntentInput.currency;

      try {
        let paymentMethodConfiguration = config.stripe.oneTimePaymentMethodConfiguration;

        const isRecurring = paymentIntentInput.frequency && paymentIntentInput.frequency !== TierFrequencyKey.ONETIME;
        if (isRecurring) {
          paymentMethodConfiguration = config.stripe.recurringPaymentMethodConfiguration;
        }

        const paymentIntent = await stripe.paymentIntents.create(
          {
            /* eslint-disable camelcase */
            payment_method_configuration: paymentMethodConfiguration,
            customer: stripeCustomerId,
            description: `Contribution to ${toAccount.name}`,
            amount: convertToStripeAmount(currency, totalOrderAmount),
            currency: paymentIntentInput.amount.currency.toLowerCase(),
            setup_future_usage: isRecurring ? 'off_session' : undefined,
            automatic_payment_methods: { enabled: true },
            /* eslint-enable camelcase */
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
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'To submit a new order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLPendingOrderCreateInput),
      },
    },
    async resolve(_, args, req) {
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

      const fromAccount = await fetchAccountWithReference(args.order.fromAccount, { throwIfMissing: true });
      const toAccount = await fetchAccountWithReference(args.order.toAccount, { throwIfMissing: true });
      const host = await toAccount.getHostCollective({ loaders: req.loaders });
      const tier = args.order.tier && (await fetchTierWithReference(args.order.tier, { throwIfMissing: true }));

      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can create pending orders');
      } else if (
        fromAccount.HostCollectiveId !== host.id &&
        !req.remoteUser.isRoot() &&
        !host.data?.allowAddFundsFromAllAccounts &&
        !host.data?.isTrustedHost
      ) {
        throw new Error(
          "You don't have the permission to create pending contributions from this account. Please contact support@opencollective.com if you want to enable this.",
        );
      }

      // Check accounting category
      let AccountingCategoryId = null;
      if (args.order.accountingCategory) {
        const accountingCategory = await fetchAccountingCategoryWithReference(args.order.accountingCategory, {
          throwIfMissing: true,
          loaders: req.loaders,
        });

        OrdersLib.checkCanUseAccountingCategoryForOrder(accountingCategory, host, toAccount);
        AccountingCategoryId = accountingCategory.id;
      }

      // Ensure amounts are provided with the right currency
      const expectedCurrency = tier?.currency || toAccount.currency;
      ['amount', 'tax.amount'].forEach(field => {
        const amount = get(args.order, field);
        if (amount) {
          assertAmountInputCurrency(amount, expectedCurrency, { name: field });
        }
      });

      // Get tax info
      const quantity = 1; // Not supported yet by PendingOrderCreateInput
      const { taxInfo, taxAmount } = getOrderTaxInfo(
        args.order.tax,
        quantity,
        args.order.amount,
        fromAccount,
        toAccount,
        host,
      );

      const baseAmountInCents = getValueInCentsFromAmountInput(args.order.amount);
      const orderProps = {
        CreatedByUserId: req.remoteUser.id,
        FromCollectiveId: fromAccount.id,
        CollectiveId: toAccount.id,
        quantity,
        totalAmount: getTotalAmountForOrderInput(baseAmountInCents, null, args.order.tax),
        currency: args.order.amount.currency,
        description: args.order.description || models.Order.generateDescription(toAccount, undefined, undefined),
        taxAmount,
        platformTipEligible: false, // Pending Contributions are not eligible to Platform Tips
        AccountingCategoryId,
        data: {
          fromAccountInfo: args.order.fromAccountInfo,
          expectedAt: args.order.expectedAt,
          ponumber: args.order.ponumber,
          memo: args.order.memo,
          paymentMethod: args.order.paymentMethod,
          isPendingContribution: true,
          hostFeePercent: args.order.hostFeePercent,
          tax: taxInfo,
        },
        status: OrderStatuses.PENDING,
      };

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

      // Update VENDOR contact info if needed
      if (
        fromAccount.type === CollectiveType.VENDOR &&
        isEmpty(fromAccount.data?.vendorInfo?.contact) &&
        args.order.fromAccountInfo
      ) {
        await fromAccount.update({
          data: {
            ...fromAccount.data,
            vendorInfo: {
              ...fromAccount.data?.vendorInfo,
              contact: pick(args.order.fromAccountInfo, ['name', 'email']),
            },
          },
        });
      }

      return order;
    },
  },
  editPendingOrder: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'To edit a pending order. Scope: "orders".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLPendingOrderEditInput),
      },
    },
    async resolve(_, args, req) {
      if (!checkScope(req, 'orders')) {
        throw new Unauthorized('The User Token is not allowed for operations in scope "orders".');
      }

      const order = await fetchOrderWithReference(args.order, {
        throwIfMissing: true,
        include: [
          { model: models.Collective, as: 'collective', required: true },
          { model: models.Tier, required: false },
        ],
      });

      if (!order) {
        throw new NotFound('Contribution not found');
      }

      const host = await order.collective.getHostCollective({ loaders: req.loaders });
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can edit pending orders');
      }

      if (order.data?.isPendingContribution !== true) {
        throw new ValidationFailed(`Only pending contributions created by fiscal-host admins can be editted`);
      }
      if (!(await OrdersLib.canEdit(req, order))) {
        throw new ValidationFailed(`Only pending orders can be edited, this one is ${order.status}`);
      }

      // Load data
      const fromAccount = await fetchAccountWithReference(args.order.fromAccount);
      const tier = args.order.tier
        ? await fetchTierWithReference(args.order.tier, { throwIfMissing: true })
        : order.tier;

      // Check accounting category
      let AccountingCategoryId = isUndefined(args.order.accountingCategory) ? order.AccountingCategoryId : null;
      if (args.order.accountingCategory) {
        const accountingCategory = await fetchAccountingCategoryWithReference(args.order.accountingCategory, {
          throwIfMissing: true,
          loaders: req.loaders,
        });

        OrdersLib.checkCanUseAccountingCategoryForOrder(accountingCategory, host, order.collective);
        AccountingCategoryId = accountingCategory.id;
      }

      // Ensure amounts are provided with the right currency
      const expectedCurrency = tier?.currency || order.collective.currency;
      ['amount', 'tax.amount', 'platformTipAmount'].forEach(field => {
        const amount = get(args.order, field);
        if (amount) {
          assertAmountInputCurrency(amount, expectedCurrency, { name: field });
        }
      });

      // Get tax info
      const quantity = 1; // Not supported yet by PendingOrderCreateInput
      const { taxInfo, taxAmount } = getOrderTaxInfo(
        args.order.tax,
        quantity,
        args.order.amount,
        fromAccount,
        order.collective,
        host,
      );

      const baseAmountInCents = getValueInCentsFromAmountInput(args.order.amount);
      const tax = !isUndefined(args.order.tax) ? args.order.tax : order.data?.tax;
      const platformTip = args.order.platformTipAmount;
      const platformTipAmount = platformTip ? getValueInCentsFromAmountInput(platformTip) : 0;
      await order.update({
        FromCollectiveId: fromAccount?.id || undefined,
        TierId: tier?.id || undefined,
        totalAmount: getTotalAmountForOrderInput(baseAmountInCents, platformTipAmount, tax),
        platformTipAmount,
        taxAmount: taxAmount || null,
        currency: args.order.amount.currency,
        description: args.order.description,
        AccountingCategoryId,
        data: {
          ...order.data,
          tax: taxInfo || null,
          ...omitBy(
            {
              ponumber: args.order.ponumber,
              memo: args.order.memo,
              paymentMethod: args.order.paymentMethod,
              fromAccountInfo: args.order.fromAccountInfo,
              expectedAt: args.order.expectedAt,
              isPendingContribution: true,
              hostFeePercent: args.order.hostFeePercent,
            },
            isUndefined,
          ),
        },
        status: OrderStatuses.PENDING,
      });

      return order;
    },
  },
  startResumeOrdersProcess: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Starts or resumes the process of notifying contributors for their PAUSED contributions',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to start/resume the process for',
      },
      message: {
        type: GraphQLString,
        description: 'An optional message to send to contributors',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      const collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized('Only collective admins can start/resume the orders process');
      } else if (collective.ParentCollectiveId) {
        throw new ValidationFailed('The Resume Contributions process can only be started from the root Collective');
      } else if (!collective.HostCollectiveId || !collective.approvedAt) {
        throw new ValidationFailed('The collective is not active');
      } else if (collective.data?.resumeContributionsStartedAt) {
        throw new ValidationFailed('The process has already been started');
      }

      // We're adding a flag to the collective to indicate that the process has started. The process itself is
      // handled by a cron job that will send the emails to the contributors.
      return collective.update({
        data: {
          ...collective.data,
          resumeContributionsMessage: args.message && sanitizeHTML(args.message, optsSanitizeHtmlForSimplified),
          resumeContributionsStartedAt: new Date(),
        },
      });
    },
  },
};

export default orderMutations;
