import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { get, round } from 'lodash';

import models from '../../models';
import { getContextPermission, PERMISSION_TYPE } from '../common/context-permissions';
import { GraphQLTaxInfo } from '../v2/object/TaxInfo';

import { CollectiveInterfaceType, UserCollectiveType } from './CollectiveInterface';
import { DateString, ExpenseType, OrderType, PaymentMethodType, SubscriptionType, UserType } from './types';

export const TransactionInterfaceType = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface',
  resolveType: transaction => {
    switch (transaction.type) {
      case 'CREDIT':
        return 'Order';
      case 'DEBIT':
        return 'Expense';
      default:
        return null;
    }
  },
  fields: () => {
    return {
      id: { type: GraphQLInt },
      idV2: { type: GraphQLString },
      uuid: { type: GraphQLString },
      amount: { type: GraphQLInt },
      currency: { type: GraphQLString },
      hostCurrency: { type: GraphQLString },
      hostCurrencyFxRate: { type: GraphQLFloat },
      netAmountInCollectiveCurrency: {
        type: GraphQLInt,
        description: 'Amount after fees received by the collective in the lowest unit of its own currency (ie. cents)',
        args: {
          fetchHostFee: {
            type: GraphQLBoolean,
            defaultValue: false,
            description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatibility.',
          },
        },
      },
      amountInHostCurrency: {
        type: GraphQLInt,
      },
      hostFeeInHostCurrency: {
        type: GraphQLInt,
        description: 'Fee kept by the host in the lowest unit of the currency of the host (ie. in cents)',
        args: {
          fetchHostFee: {
            type: GraphQLBoolean,
            defaultValue: false,
            description: 'Fetch HOST_FEE transaction for retro-compatibility.',
          },
        },
      },
      platformFeeInHostCurrency: { type: GraphQLInt },
      paymentProcessorFeeInHostCurrency: { type: GraphQLInt },
      taxAmount: { type: GraphQLInt },
      taxInfo: { type: GraphQLTaxInfo },
      createdByUser: { type: UserType },
      host: { type: CollectiveInterfaceType },
      paymentMethod: { type: PaymentMethodType },
      fromCollective: { type: CollectiveInterfaceType },
      usingGiftCardFromCollective: { type: CollectiveInterfaceType },
      collective: { type: CollectiveInterfaceType },
      type: { type: GraphQLString },
      kind: { type: GraphQLString },
      description: { type: GraphQLString },
      createdAt: { type: DateString },
      updatedAt: { type: DateString },
      refundTransaction: { type: TransactionInterfaceType },
      isRefund: { type: GraphQLBoolean },
      invoiceTemplate: { type: GraphQLString },
    };
  },
});

const TransactionFields = () => {
  return {
    id: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.id;
      },
    },
    idV2: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.uuid;
      },
    },
    refundTransaction: {
      type: TransactionInterfaceType,
      resolve(transaction) {
        return transaction.getRefundTransaction();
      },
    },
    isRefund: {
      type: GraphQLBoolean,
      resolve(transaction) {
        return transaction.isRefund;
      },
    },
    uuid: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.uuid;
      },
    },
    type: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.type;
      },
    },
    kind: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.kind;
      },
    },
    amount: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.amount;
      },
    },
    currency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.currency;
      },
    },
    hostCurrency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.hostCurrency;
      },
    },
    hostCurrencyFxRate: {
      type: GraphQLFloat,
      description:
        'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
      resolve(transaction) {
        return transaction.hostCurrencyFxRate;
      },
    },
    hostFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the host in the lowest unit of the currency of the host (ie. in cents)',
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction for retro-compatiblity.',
        },
      },
      resolve(transaction, args, req) {
        if (args.fetchHostFee && !transaction.hostFeeInHostCurrency) {
          return req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
        }
        return transaction.hostFeeInHostCurrency;
      },
    },
    platformFeeInHostCurrency: {
      type: GraphQLInt,
      description:
        'Fee kept by the Open Collective Platform in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.platformFeeInHostCurrency;
      },
    },
    paymentProcessorFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the payment processor in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.paymentProcessorFeeInHostCurrency;
      },
    },
    taxAmount: {
      type: GraphQLInt,
      description: 'The amount paid in tax (for example VAT) for this transaction',
    },
    taxInfo: {
      type: GraphQLTaxInfo,
      description: 'If taxAmount is set, this field will contain more info about the tax',
      resolve(transaction, _, req) {
        const tax = transaction.data?.tax;
        if (!tax) {
          return null;
        } else {
          return {
            id: tax.id,
            type: tax.id,
            percentage: Math.round(tax.percentage ?? tax.rate * 100), // Does not support float
            rate: tax.rate ?? round(tax.percentage / 100, 2),
            idNumber: () => {
              const collectiveId = transaction.paymentMethodProviderCollectiveId();
              const canSeeDetails =
                getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, collectiveId) ||
                req.remoteUser.isAdmin(transaction.HostCollectiveId);

              return canSeeDetails ? tax.idNumber : null;
            },
          };
        }
      },
    },
    netAmountInCollectiveCurrency: {
      type: GraphQLInt,
      description: 'Amount after fees received by the collective in the lowest unit of its own currency (ie. cents)',
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        if (args.fetchHostFee && !transaction.hostFeeInHostCurrency) {
          transaction.hostFeeInHostCurrency =
            await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
          return models.Transaction.calculateNetAmountInCollectiveCurrency(transaction);
        }
        return transaction.netAmountInCollectiveCurrency;
      },
    },
    amountInHostCurrency: {
      type: GraphQLInt,
      async resolve(transaction) {
        return transaction.amountInHostCurrency;
      },
    },
    host: {
      type: UserCollectiveType,
      async resolve(transaction, args, req) {
        if (transaction.HostCollectiveId) {
          return req.loaders.Collective.byId.load(transaction.HostCollectiveId);
        }

        const fromCollective = await req.loaders.Collective.byId.load(transaction.FromCollectiveId);
        if (fromCollective.HostCollectiveId) {
          return req.loaders.Collective.byId.load(fromCollective.HostCollectiveId);
        }

        const collective = await req.loaders.Collective.byId.load(transaction.CollectiveId);
        if (collective.HostCollectiveId) {
          return req.loaders.Collective.byId.load(fromCollective.HostCollectiveId);
        }
      },
    },
    createdByUser: {
      type: UserType,
      async resolve(transaction, args, req) {
        if (!transaction.CreatedByUserId) {
          return;
        }

        const [collective, fromCollective] = await req.loaders.Collective.byId.loadMany([
          transaction.CollectiveId,
          transaction.FromCollectiveId,
        ]);

        if (fromCollective.isIncognito && !req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
          return {};
        }

        if (collective.isIncognito && !req.remoteUser?.isAdminOfCollectiveOrHost(fromCollective)) {
          return {};
        }

        return req.loaders.User.byId.load(transaction.CreatedByUserId);
      },
    },
    fromCollective: {
      type: CollectiveInterfaceType,
      async resolve(transaction, args, req) {
        return req.loaders.Collective.byId.load(transaction.FromCollectiveId);
      },
    },
    usingGiftCardFromCollective: {
      type: CollectiveInterfaceType,
      resolve(transaction, args, req) {
        if (transaction && transaction.UsingGiftCardFromCollectiveId) {
          return req.loaders.Collective.byId.load(transaction.UsingGiftCardFromCollectiveId);
        }
        return null;
      },
    },
    collective: {
      type: CollectiveInterfaceType,
      async resolve(transaction, args, req) {
        return req.loaders.Collective.byId.load(transaction.CollectiveId);
      },
    },
    createdAt: {
      type: DateString,
      resolve(transaction) {
        return transaction.createdAt;
      },
    },
    updatedAt: {
      type: DateString,
      resolve(transaction) {
        return transaction.updatedAt;
      },
    },
    paymentMethod: {
      type: PaymentMethodType,
      resolve(transaction, args, req) {
        const paymentMethodId = transaction.PaymentMethodId || get(transaction, 'paymentMethod.id');
        if (!paymentMethodId) {
          return null;
        }
        // TODO: put behind a login check
        return req.loaders.PaymentMethod.byId.load(paymentMethodId);
      },
    },
    invoiceTemplate: {
      type: GraphQLString,
      async resolve(transaction) {
        return transaction.data?.invoiceTemplate;
      },
    },
  };
};
export const TransactionExpenseType = new GraphQLObjectType({
  name: 'Expense',
  description: 'Expense model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        resolve(transaction) {
          // If it's a sequelize model transaction, it means it has the method getExpense
          // otherwise we return transaction.description , if not then return null
          const expense = transaction.getExpense
            ? transaction.getExpense().then(expense => expense && expense.description)
            : null;
          return transaction.description || expense;
        },
      },
      expense: {
        type: ExpenseType,
        resolve(transaction, args, req) {
          // If it's a expense transaction it'll have an ExpenseId
          // otherwise we return null
          return transaction.ExpenseId ? req.loaders.Expense.byId.load(transaction.ExpenseId) : null;
        },
      },
    };
  },
});

export const TransactionOrderType = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        async resolve(transaction, _, req) {
          if (transaction.description) {
            return transaction.description;
          } else {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            return order?.description;
          }
        },
      },
      publicMessage: {
        type: GraphQLString,
        async resolve(transaction, _, req) {
          if (transaction.OrderId) {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            return order?.publicMessage;
          }
        },
      },
      order: {
        type: OrderType,
        resolve(transaction, _, req) {
          if (transaction.OrderId) {
            return req.loaders.Order.byId.load(transaction.OrderId);
          }
        },
      },
      subscription: {
        type: SubscriptionType,
        async resolve(transaction, _, req) {
          if (transaction.OrderId) {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            if (order?.SubscriptionId) {
              return req.loaders.Subscription.byId.load(order.SubscriptionId);
            }
          }
        },
      },
    };
  },
});
