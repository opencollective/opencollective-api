import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { isNil, round } from 'lodash';

import orderStatus from '../../../constants/order_status';
import roles from '../../../constants/roles';
import { TransactionKind as TransactionKinds } from '../../../constants/transaction-kind';
import { generateDescription } from '../../../lib/transactions';
import models from '../../../models';
import { allowContextPermission, getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import * as TransactionLib from '../../common/transactions';
import { TransactionKind } from '../enum/TransactionKind';
import { TransactionType } from '../enum/TransactionType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Amount } from '../object/Amount';
import { Expense } from '../object/Expense';
import { Order } from '../object/Order';
import { PaymentMethod } from '../object/PaymentMethod';
import PayoutMethod from '../object/PayoutMethod';
import { TaxInfo } from '../object/TaxInfo';

import { Account } from './Account';

const TransactionPermissions = new GraphQLObjectType({
  name: 'TransactionPermissions',
  description: 'Fields for the user permissions on an transaction',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.TRANSACTION),
    },
    canRefund: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the transaction',
      resolve: TransactionLib.canRefund,
    },
    canDownloadInvoice: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "Whether the current user can download this transaction's invoice",
      resolve: TransactionLib.canDownloadInvoice,
    },
    canReject: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can reject the transaction',
      resolve: TransactionLib.canReject,
    },
  }),
});

const transactionFieldsDefinition = () => ({
  id: {
    type: new GraphQLNonNull(GraphQLString),
  },
  legacyId: {
    type: new GraphQLNonNull(GraphQLInt),
  },
  uuid: {
    type: new GraphQLNonNull(GraphQLString),
    deprecationReason: '2021-08-15: Use id instead.',
  },
  group: {
    type: new GraphQLNonNull(GraphQLString),
  },
  type: {
    type: new GraphQLNonNull(TransactionType),
  },
  kind: {
    type: TransactionKind,
  },
  description: {
    type: GraphQLString,
    args: {
      dynamic: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Wether to generate the description dynamically.',
      },
      full: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Wether to generate the full description when using dynamic.',
      },
    },
  },
  amount: {
    type: new GraphQLNonNull(Amount),
  },
  amountInHostCurrency: {
    type: new GraphQLNonNull(Amount),
  },
  hostCurrencyFxRate: {
    type: GraphQLFloat,
    description:
      'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
  },
  netAmount: {
    type: new GraphQLNonNull(Amount),
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
      },
    },
  },
  netAmountInHostCurrency: {
    type: new GraphQLNonNull(Amount),
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
      },
    },
  },
  taxAmount: {
    type: new GraphQLNonNull(Amount),
  },
  taxInfo: {
    type: TaxInfo,
    description: 'If taxAmount is set, this field will contain more info about the tax',
  },
  platformFee: {
    type: new GraphQLNonNull(Amount),
  },
  hostFee: {
    type: Amount,
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction for retro-compatiblity.',
      },
    },
  },
  paymentProcessorFee: {
    type: Amount,
  },
  host: {
    type: Account,
  },
  account: {
    type: Account,
  },
  oppositeAccount: {
    type: Account,
  },
  fromAccount: {
    type: Account,
    description: 'The sender of a transaction (on CREDIT = oppositeAccount, DEBIT = account)',
  },
  toAccount: {
    type: Account,
    description: 'The recipient of a transaction (on CREDIT = account, DEBIT = oppositeAccount)',
  },
  giftCardEmitterAccount: {
    type: Account,
  },
  createdAt: {
    type: GraphQLDateTime,
  },
  updatedAt: {
    type: GraphQLDateTime,
  },
  expense: {
    type: Expense,
  },
  order: {
    type: Order,
  },
  isRefunded: {
    type: GraphQLBoolean,
  },
  isRefund: {
    type: GraphQLBoolean,
  },
  isDisputed: {
    type: GraphQLBoolean,
  },
  isInReview: {
    type: GraphQLBoolean,
  },
  paymentMethod: {
    type: PaymentMethod,
  },
  payoutMethod: {
    type: PayoutMethod,
  },
  permissions: {
    type: TransactionPermissions,
  },
  isOrderRejected: {
    type: new GraphQLNonNull(GraphQLBoolean),
  },
  refundTransaction: {
    type: Transaction,
  },
  oppositeTransaction: {
    type: Transaction,
    description: 'The opposite transaction (CREDIT -> DEBIT, DEBIT -> CREDIT)',
  },
  relatedTransactions: {
    type: new GraphQLNonNull(new GraphQLList(Transaction)),
    args: {
      kind: {
        type: new GraphQLList(TransactionKind),
        description: 'Filter by kind',
      },
    },
  },
  merchantId: {
    type: GraphQLString,
    description: 'Merchant id related to the Transaction (Stripe, PayPal, Wise, Privacy)',
  },
  balanceInHostCurrency: {
    type: Amount,
    description: 'The balance after the Transaction has run. Only for financially active accounts.',
  },
  invoiceTemplate: {
    type: GraphQLString,
    async resolve(transaction) {
      return transaction.data?.invoiceTemplate;
    },
  },
});

export const Transaction = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface shared by all kind of transactions (Debit, Credit)',
  fields: transactionFieldsDefinition,
});

export const TransactionFields = () => {
  return {
    ...transactionFieldsDefinition(),
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(transaction) {
        return transaction.uuid;
      },
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve(transaction) {
        return transaction.id;
      },
    },
    group: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(transaction) {
        return transaction.TransactionGroup;
      },
    },
    description: {
      type: GraphQLString,
      args: {
        dynamic: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Wether to generate the description dynamically.',
        },
        full: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Wether to generate the full description when using dynamic.',
        },
      },
      resolve(transaction, args, req) {
        return args.dynamic ? generateDescription(transaction, { req, full: args.full }) : transaction.description;
      },
    },
    amount: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return { value: transaction.amount, currency: transaction.currency };
      },
    },
    amountInHostCurrency: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return { value: transaction.amountInHostCurrency, currency: transaction.hostCurrency };
      },
    },
    hostCurrencyFxRate: {
      type: GraphQLFloat,
      description:
        'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
    },
    netAmount: {
      type: new GraphQLNonNull(Amount),
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let value = transaction.netAmountInCollectiveCurrency;
        if (args.fetchHostFee && !transaction.hostFeeInHostCurrency) {
          const hostFeeInHostCurrency = await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
          value = models.Transaction.calculateNetAmountInCollectiveCurrency({
            ...transaction.dataValues,
            hostFeeInHostCurrency,
          });
        }
        return {
          value,
          currency: transaction.currency,
        };
      },
    },
    netAmountInHostCurrency: {
      type: new GraphQLNonNull(Amount),
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let value = transaction.netAmountInHostCurrency;
        if (args.fetchHostFee && !transaction.hostFeeInHostCurrency) {
          const hostFeeInHostCurrency = await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
          value = models.Transaction.calculateNetAmountInHostCurrency({
            ...transaction.dataValues,
            hostFeeInHostCurrency,
          });
        }
        return {
          value,
          currency: transaction.hostCurrency,
        };
      },
    },
    taxAmount: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return {
          value: transaction.taxAmount,
          currency: transaction.currency,
        };
      },
    },
    taxInfo: {
      type: TaxInfo,
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
    platformFee: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return {
          value: transaction.platformFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    hostFee: {
      type: new GraphQLNonNull(Amount),
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let hostFeeInHostCurrency = transaction.hostFeeInHostCurrency;
        if (args.fetchHostFee && !hostFeeInHostCurrency) {
          hostFeeInHostCurrency = await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
        }
        return {
          value: hostFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    paymentProcessorFee: {
      type: new GraphQLNonNull(Amount),
      description: 'Payment Processor Fee (usually in host currency)',
      resolve(transaction) {
        return {
          value: transaction.paymentProcessorFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    host: {
      type: Account,
      resolve(transaction, _, req) {
        if (transaction.HostCollectiveId) {
          return req.loaders.Collective.byId.load(transaction.HostCollectiveId);
        } else {
          return null;
        }
      },
    },
    account: {
      type: Account,
      description: 'The account on the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
      resolve(transaction, _, req) {
        if (req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
          allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, transaction.CollectiveId);
        }

        return req.loaders.Collective.byId.load(transaction.CollectiveId);
      },
    },
    oppositeAccount: {
      type: Account,
      description: 'The account on the opposite side of the transaction (CREDIT -> sender, DEBIT -> recipient)',
      resolve(transaction, _, req) {
        if (req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
          allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, transaction.FromCollectiveId);
        }

        return req.loaders.Collective.byId.load(transaction.FromCollectiveId);
      },
    },
    updatedAt: {
      type: GraphQLDateTime,
      resolve(transaction) {
        // Transactions are immutable right?
        return transaction.createdAt;
      },
    },
    expense: {
      type: Expense,
      resolve(transaction, _, req) {
        if (transaction.ExpenseId) {
          return req.loaders.Expense.byId.load(transaction.ExpenseId);
        } else {
          return null;
        }
      },
    },
    order: {
      type: Order,
      resolve(transaction, _, req) {
        if (transaction.OrderId) {
          return req.loaders.Order.byId.load(transaction.OrderId);
        } else {
          return null;
        }
      },
    },
    isRefunded: {
      type: GraphQLBoolean,
      resolve(transaction) {
        return transaction.isRefund !== true && transaction.RefundTransactionId !== null;
      },
    },
    paymentMethod: {
      type: PaymentMethod,
      resolve(transaction, _, req) {
        if (transaction.PaymentMethodId) {
          return req.loaders.PaymentMethod.byId.load(transaction.PaymentMethodId);
        } else {
          return null;
        }
      },
    },
    payoutMethod: {
      type: PayoutMethod,
      resolve(transaction, _, req) {
        if (transaction.PayoutMethodId) {
          return req.loaders.PayoutMethod.byId.load(transaction.PayoutMethodId);
        } else {
          return null;
        }
      },
    },
    permissions: {
      type: new GraphQLNonNull(TransactionPermissions),
      description: 'The permissions given to current logged in user for this transaction',
      async resolve(transaction) {
        return transaction; // Individual fields are set by TransactionPermissions's resolvers
      },
    },
    giftCardEmitterAccount: {
      type: Account,
      description: 'Account that emitted the gift card used for this transaction (if any)',
      async resolve(transaction, _, req) {
        return transaction.UsingGiftCardFromCollectiveId
          ? await req.loaders.Collective.byId.load(transaction.UsingGiftCardFromCollectiveId)
          : null;
      },
    },
    isOrderRejected: {
      type: new GraphQLNonNull(GraphQLBoolean),
      async resolve(transaction, _, req) {
        if (transaction.OrderId) {
          const order = await req.loaders.Order.byId.load(transaction.OrderId);
          return order.status === orderStatus.REJECTED;
        } else {
          return false;
        }
      },
    },
    refundTransaction: {
      type: Transaction,
      resolve(transaction, _, req) {
        if (transaction.RefundTransactionId) {
          return req.loaders.Transaction.byId.load(transaction.RefundTransactionId);
        } else {
          return null;
        }
      },
    },
    oppositeTransaction: {
      type: Transaction,
      description: 'The opposite transaction (CREDIT -> DEBIT, DEBIT -> CREDIT)',
      resolve(transaction, _, req) {
        return req.loaders.Transaction.oppositeTransaction.load(transaction);
      },
    },
    relatedTransactions: {
      type: new GraphQLNonNull(new GraphQLList(Transaction)),
      args: {
        kind: {
          type: new GraphQLList(TransactionKind),
          description: 'Filter by kind',
        },
      },
      async resolve(transaction, args, req) {
        const relatedTransactions = await req.loaders.Transaction.relatedTransactions.load(transaction);
        if (args.kind) {
          return relatedTransactions.filter(t => args.kind.includes(t.kind));
        } else {
          return relatedTransactions;
        }
      },
    },
    merchantId: {
      type: GraphQLString,
      description: 'Merchant id related to the Transaction (Stripe, PayPal, Wise, Privacy)',
      async resolve(transaction, _, req) {
        if (!req.remoteUser || !req.remoteUser.hasRole([roles.ACCOUNTANT, roles.ADMIN], transaction.HostCollectiveId)) {
          return;
        }

        if (transaction.kind === TransactionKinds.CONTRIBUTION) {
          const stripeId = transaction.data?.charge?.id;
          const onetimePaypalPaymentId = transaction.data?.capture?.id;
          const recurringPaypalPaymentId = transaction.data?.paypalSale?.id;

          return stripeId || onetimePaypalPaymentId || recurringPaypalPaymentId;
        }

        if (transaction.kind === TransactionKinds.EXPENSE) {
          let expense = transaction.expense;
          if (!expense && transaction.ExpenseId) {
            expense = await req.loaders.Expense.byId.load(transaction.ExpenseId);
          }

          const wiseId = transaction.data?.transfer?.id;
          // TODO: PayPal Adaptive is missing
          // https://github.com/opencollective/opencollective/issues/4891
          const paypalPayoutId = transaction.data?.transaction_id;
          const privacyId = transaction.data?.token;

          // NOTE: We don't have transaction?.data?.transaction stored for transactions < 2022-09-27, but we have it available in expense.data
          const stripeVirtualCardId = transaction?.data?.transaction?.id || expense?.data?.transactionId;

          return wiseId || paypalPayoutId || privacyId || stripeVirtualCardId;
        }
      },
    },
    balanceInHostCurrency: {
      type: Amount,
      async resolve(transaction, _, req) {
        const result = await req.loaders.Transaction.balanceById.load(transaction.id);
        if (!isNil(result?.balance)) {
          return { value: result.balance, currency: transaction.hostCurrency };
        }
      },
    },
  };
};
