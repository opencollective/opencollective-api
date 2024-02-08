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

import orderStatus from '../../../constants/order-status';
import roles from '../../../constants/roles';
import { TransactionKind } from '../../../constants/transaction-kind';
import { generateDescription } from '../../../lib/transactions';
import PaymentMethod from '../../../models/PaymentMethod';
import Transaction from '../../../models/Transaction';
import { allowContextPermission, getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import * as TransactionLib from '../../common/transactions';
import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { GraphQLTransactionType } from '../enum/TransactionType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLExpense } from '../object/Expense';
import { GraphQLOrder } from '../object/Order';
import { GraphQLPaymentMethod } from '../object/PaymentMethod';
import GraphQLPayoutMethod from '../object/PayoutMethod';
import { GraphQLTaxInfo } from '../object/TaxInfo';

import { GraphQLAccount } from './Account';

const { CONTRIBUTION, EXPENSE } = TransactionKind;

const GraphQLTransactionPermissions = new GraphQLObjectType({
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
    type: new GraphQLNonNull(GraphQLTransactionType),
  },
  kind: {
    type: GraphQLTransactionKind,
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
    type: new GraphQLNonNull(GraphQLAmount),
  },
  amountInHostCurrency: {
    type: new GraphQLNonNull(GraphQLAmount),
  },
  hostCurrencyFxRate: {
    type: GraphQLFloat,
    description:
      'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
  },
  netAmount: {
    type: new GraphQLNonNull(GraphQLAmount),
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
      },
      fetchPaymentProcessorFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
      },
      fetchTax: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch TAX transaction for retro-compatiblity.',
      },
    },
  },
  netAmountInHostCurrency: {
    type: new GraphQLNonNull(GraphQLAmount),
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
      },
      fetchPaymentProcessorFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
      },
      fetchTax: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch TAX transaction for retro-compatiblity.',
      },
    },
  },
  taxAmount: {
    type: new GraphQLNonNull(GraphQLAmount),
    args: {
      fetchTax: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch TAX transaction for retro-compatiblity.',
      },
    },
  },
  taxInfo: {
    type: GraphQLTaxInfo,
    description: 'If a tax is set, this field will contain more info about the tax',
  },
  platformFee: {
    type: new GraphQLNonNull(GraphQLAmount),
  },
  hostFee: {
    type: GraphQLAmount,
    args: {
      fetchHostFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch HOST_FEE transaction for retro-compatiblity.',
      },
    },
  },
  paymentProcessorFee: {
    type: GraphQLAmount,
    args: {
      fetchPaymentProcessorFee: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
      },
    },
  },
  host: {
    type: GraphQLAccount,
  },
  account: {
    type: GraphQLAccount,
  },
  oppositeAccount: {
    type: GraphQLAccount,
  },
  fromAccount: {
    type: GraphQLAccount,
    description: 'The sender of a transaction (on CREDIT = oppositeAccount, DEBIT = account)',
  },
  toAccount: {
    type: GraphQLAccount,
    description: 'The recipient of a transaction (on CREDIT = account, DEBIT = oppositeAccount)',
  },
  giftCardEmitterAccount: {
    type: GraphQLAccount,
  },
  createdAt: {
    type: GraphQLDateTime,
  },
  updatedAt: {
    type: GraphQLDateTime,
  },
  expense: {
    type: GraphQLExpense,
  },
  order: {
    type: GraphQLOrder,
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
    type: GraphQLPaymentMethod,
  },
  payoutMethod: {
    type: GraphQLPayoutMethod,
  },
  permissions: {
    type: GraphQLTransactionPermissions,
  },
  isOrderRejected: {
    type: new GraphQLNonNull(GraphQLBoolean),
  },
  refundTransaction: {
    type: GraphQLTransaction,
  },
  oppositeTransaction: {
    type: GraphQLTransaction,
    description: 'The opposite transaction (CREDIT -> DEBIT, DEBIT -> CREDIT)',
  },
  relatedTransactions: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLTransaction)),
    args: {
      kind: {
        type: new GraphQLList(GraphQLTransactionKind),
        description: 'Filter by kind',
      },
    },
  },
  merchantId: {
    type: GraphQLString,
    description: 'Merchant id related to the Transaction (Stripe, PayPal, Wise, Privacy)',
  },
  balanceInHostCurrency: {
    type: GraphQLAmount,
    description: 'The balance after the Transaction has run. Only for financially active accounts.',
  },
  invoiceTemplate: {
    type: GraphQLString,
    async resolve(transaction) {
      return transaction.data?.invoiceTemplate;
    },
  },
});

export const GraphQLTransaction = new GraphQLInterfaceType({
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
      type: new GraphQLNonNull(GraphQLAmount),
      resolve(transaction) {
        return { value: transaction.amount, currency: transaction.currency };
      },
    },
    amountInHostCurrency: {
      type: new GraphQLNonNull(GraphQLAmount),
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
      type: new GraphQLNonNull(GraphQLAmount),
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
        },
        fetchPaymentProcessorFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
        },
        fetchTax: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch TAX transaction for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let { netAmountInCollectiveCurrency, hostFeeInHostCurrency, paymentProcessorFeeInHostCurrency, taxAmount } =
          transaction;
        if (args.fetchHostFee && !hostFeeInHostCurrency) {
          hostFeeInHostCurrency = await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
        }
        if (args.fetchPaymentProcessorFee && !paymentProcessorFeeInHostCurrency) {
          paymentProcessorFeeInHostCurrency =
            await req.loaders.Transaction.paymentProcessorFeeAmountForTransaction.load(transaction);
        }
        if (args.fetchTax && !taxAmount) {
          taxAmount = await req.loaders.Transaction.taxAmountForTransaction.load(transaction);
        }
        if (args.fetchHostFee || args.fetchPaymentProcessorFee || args.fetchTax) {
          netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency({
            ...transaction.dataValues,
            hostFeeInHostCurrency,
            paymentProcessorFeeInHostCurrency,
            taxAmount,
          });
        }
        return {
          value: netAmountInCollectiveCurrency,
          currency: transaction.currency,
        };
      },
    },
    netAmountInHostCurrency: {
      type: new GraphQLNonNull(GraphQLAmount),
      args: {
        fetchHostFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch HOST_FEE transaction and integrate in calculation for retro-compatiblity.',
        },
        fetchPaymentProcessorFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
        },
        fetchTax: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch TAX transaction for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let { netAmountInHostCurrency, hostFeeInHostCurrency, paymentProcessorFeeInHostCurrency, taxAmount } =
          transaction;
        if (args.fetchHostFee && !hostFeeInHostCurrency) {
          hostFeeInHostCurrency = await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction);
        }
        if (args.fetchPaymentProcessorFee && !paymentProcessorFeeInHostCurrency) {
          paymentProcessorFeeInHostCurrency =
            await req.loaders.Transaction.paymentProcessorFeeAmountForTransaction.load(transaction);
        }
        if (args.fetchTax && !taxAmount) {
          taxAmount = await req.loaders.Transaction.taxAmountForTransaction.load(transaction);
        }
        if (args.fetchHostFee || args.fetchPaymentProcessorFee || args.fetchTax) {
          netAmountInHostCurrency = Transaction.calculateNetAmountInHostCurrency({
            ...transaction.dataValues,
            hostFeeInHostCurrency,
            paymentProcessorFeeInHostCurrency,
            taxAmount,
          });
        }
        return {
          value: netAmountInHostCurrency,
          currency: transaction.hostCurrency,
        };
      },
    },
    taxAmount: {
      type: new GraphQLNonNull(GraphQLAmount),
      args: {
        fetchTax: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch TAX transaction for retro-compatiblity.',
        },
      },
      async resolve(transaction, args, req) {
        let taxAmount = transaction.taxAmount;
        if (args.fetchTax && !taxAmount) {
          taxAmount = await req.loaders.Transaction.taxAmountForTransaction.load(transaction);
        }
        return {
          value: taxAmount,
          currency: transaction.currency,
        };
      },
    },
    taxInfo: {
      type: GraphQLTaxInfo,
      description: 'If a tax is set, this field will contain more info about the tax',
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
      type: new GraphQLNonNull(GraphQLAmount),
      resolve(transaction) {
        return {
          value: transaction.platformFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    hostFee: {
      type: new GraphQLNonNull(GraphQLAmount),
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
      type: new GraphQLNonNull(GraphQLAmount),
      args: {
        fetchPaymentProcessorFee: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Fetch PAYMENT_PROCESSOR_FEE transaction for retro-compatiblity.',
        },
      },
      description: 'Payment Processor Fee (usually in host currency)',
      async resolve(transaction, args, req) {
        let paymentProcessorFeeInHostCurrency = transaction.paymentProcessorFeeInHostCurrency;
        if (args.fetchPaymentProcessorFee && !paymentProcessorFeeInHostCurrency) {
          paymentProcessorFeeInHostCurrency =
            await req.loaders.Transaction.paymentProcessorFeeAmountForTransaction.load(transaction);
        }
        return {
          value: paymentProcessorFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    host: {
      type: GraphQLAccount,
      resolve(transaction, _, req) {
        if (transaction.HostCollectiveId) {
          return req.loaders.Collective.byId.load(transaction.HostCollectiveId);
        } else {
          return null;
        }
      },
    },
    account: {
      type: GraphQLAccount,
      description: 'The account on the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
      resolve(transaction, _, req) {
        if (req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
          allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, transaction.CollectiveId);
        }

        return req.loaders.Collective.byId.load(transaction.CollectiveId);
      },
    },
    oppositeAccount: {
      type: GraphQLAccount,
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
      type: GraphQLExpense,
      resolve(transaction, _, req) {
        if (transaction.ExpenseId) {
          return req.loaders.Expense.byId.load(transaction.ExpenseId);
        } else {
          return null;
        }
      },
    },
    order: {
      type: GraphQLOrder,
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
      type: GraphQLPaymentMethod,
      async resolve(transaction, _, req) {
        if (transaction.PaymentMethodId) {
          let result = await req.loaders.PaymentMethod.byId.load(transaction.PaymentMethodId);
          // NOTE: we're curently sometime soft-deleting paymentMethods instead of archiving them
          // For the time being, we'll need to fetch them with paranoid=false
          if (!result) {
            result = await PaymentMethod.findByPk(transaction.PaymentMethodId, { paranoid: false });
          }
          return result;
        } else {
          return null;
        }
      },
    },
    payoutMethod: {
      type: GraphQLPayoutMethod,
      resolve(transaction, _, req) {
        if (transaction.PayoutMethodId) {
          return req.loaders.PayoutMethod.byId.load(transaction.PayoutMethodId);
        } else {
          return null;
        }
      },
    },
    permissions: {
      type: new GraphQLNonNull(GraphQLTransactionPermissions),
      description: 'The permissions given to current logged in user for this transaction',
      async resolve(transaction) {
        return transaction; // Individual fields are set by TransactionPermissions's resolvers
      },
    },
    giftCardEmitterAccount: {
      type: GraphQLAccount,
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
      type: GraphQLTransaction,
      resolve(transaction, _, req) {
        if (transaction.RefundTransactionId) {
          return req.loaders.Transaction.byId.load(transaction.RefundTransactionId);
        } else {
          return null;
        }
      },
    },
    oppositeTransaction: {
      type: GraphQLTransaction,
      description: 'The opposite transaction (CREDIT -> DEBIT, DEBIT -> CREDIT)',
      async resolve(transaction, _, req) {
        const relatedTransactions = await req.loaders.Transaction.relatedTransactions.load(transaction);
        return relatedTransactions.find(
          t => t.kind === transaction.kind && t.isDebt === transaction.isDebt && t.type !== transaction.type,
        );
      },
    },
    relatedTransactions: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLTransaction)),
      args: {
        kind: {
          type: new GraphQLList(GraphQLTransactionKind),
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

        if (transaction.kind === CONTRIBUTION) {
          const stripeId = transaction.data?.charge?.id;
          const onetimePaypalPaymentId = transaction.data?.capture?.id;
          const recurringPaypalPaymentId = transaction.data?.paypalSale?.id;
          // Refunded PayPal contributions
          const paypalResponseId = transaction.data?.paypalResponse?.id;

          return stripeId || onetimePaypalPaymentId || recurringPaypalPaymentId || paypalResponseId;
        }

        if (transaction.kind === EXPENSE) {
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
          const stripeVirtualCardId = transaction.data?.transaction?.id || expense?.data?.transactionId;

          return wiseId || paypalPayoutId || privacyId || stripeVirtualCardId;
        }
      },
    },
    balanceInHostCurrency: {
      type: GraphQLAmount,
      async resolve(transaction, _, req) {
        const result = await req.loaders.Transaction.balanceById.load(transaction.id);
        if (!isNil(result?.balance)) {
          return { value: result.balance, currency: transaction.hostCurrency };
        }
      },
    },
  };
};
