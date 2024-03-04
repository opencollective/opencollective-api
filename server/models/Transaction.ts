import assert from 'assert';

import config from 'config';
import debugLib from 'debug';
import { compact, get, head, isNil, isNull, isUndefined, memoize, omit, pick } from 'lodash';
import moment from 'moment';
import {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  Model,
  ModelStatic,
  Transaction as SequelizeTransaction,
} from 'sequelize';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

import activities from '../constants/activities';
import { SupportedCurrency } from '../constants/currencies';
import { PAYMENT_METHOD_SERVICE } from '../constants/paymentMethods';
import { TransactionKind } from '../constants/transaction-kind';
import {
  HOST_FEE_SHARE_TRANSACTION_PROPERTIES,
  PLATFORM_TIP_TRANSACTION_PROPERTIES,
  TransactionTypes,
} from '../constants/transactions';
import { shouldGenerateTransactionActivities } from '../lib/activities';
import { getFxRate } from '../lib/currency';
import { toNegative } from '../lib/math';
import { calcFee, getHostFeeSharePercent } from '../lib/payments';
import { stripHTML } from '../lib/sanitize-html';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import { exportToCSV, parseToBoolean } from '../lib/utils';
import type { PaypalCapture, PaypalSale, PaypalTransaction } from '../types/paypal';
import type { Transfer } from '../types/transferwise';

import Activity from './Activity';
import Collective from './Collective';
import CustomDataTypes from './DataTypes';
import type Expense from './Expense';
import type { ExpenseTaxDefinition } from './Expense';
import Order, { OrderModelInterface, OrderTax } from './Order';
import PaymentMethod, { PaymentMethodModelInterface } from './PaymentMethod';
import PayoutMethod, { PayoutMethodTypes } from './PayoutMethod';
import TransactionSettlement, { TransactionSettlementStatus } from './TransactionSettlement';
import User from './User';

const { CREDIT, DEBIT } = TransactionTypes;

const { CONTRIBUTION, EXPENSE, ADDED_FUNDS } = TransactionKind;
export const MERCHANT_ID_PATHS = {
  [CONTRIBUTION]: [
    'data.charge.id', // stripeId
    'data.capture.id', // onetimePaypalPaymentId
    'data.paypalSale.id', // recurringPaypalPaymentId
    'data.paypalResponse.id', // paypalResponseId
  ],
  [EXPENSE]: [
    'data.transfer.id', // wiseId
    'data.transaction_id', // paypalPayoutId
    'data.token', // privacyId
    'data.transaction.id', // stripeVirtualCardId
  ],
} as const;

const debug = debugLib('models:Transaction');

type Tax = OrderTax | ExpenseTaxDefinition;

export type TransactionData = {
  balanceTransaction?: Stripe.BalanceTransaction;
  capture?: Partial<PaypalCapture>;
  charge?: Stripe.Charge;
  dispute?: Stripe.Dispute;
  expenseToHostFxRate?: number;
  feesPayer?: Expense['feesPayer'];
  hasPlatformTip?: boolean;
  hostFeeMigration?: string;
  hostFeeSharePercent?: number;
  hostToPlatformFxRate?: number;
  isManual?: boolean;
  isPlatformRevenueDirectlyCollected?: boolean;
  isRefundedFromOurSystem?: boolean;
  oppositeTransactionFeesCurrencyFxRate?: number;
  oppositeTransactionHostCurrencyFxRate?: number;
  paymentProcessorFeeMigration?: string;
  paypalResponse?: Record<string, unknown>;
  paypalSale?: Partial<PaypalSale>;
  paypalTransaction?: Partial<PaypalTransaction>;
  platformTip?: number;
  platformTipInHostCurrency?: number;
  preMigrationData?: TransactionData;
  refund?: Stripe.Refund;
  refundedFromDoubleTransactionsScript?: boolean;
  refundReason?: string;
  refundTransactionId?: TransactionInterface['id'];
  review?: Stripe.Event; // Why not Stripe.Review? Who knows
  tax?: Tax;
  taxAmountRemovedFromMigration?: number;
  taxMigration?: string;
  taxRemovedFromMigration?: Tax;
  transfer?: Transfer;
};

export interface TransactionInterface
  extends Model<InferAttributes<TransactionInterface>, InferCreationAttributes<TransactionInterface>> {
  id: CreationOptional<number>;
  type: TransactionTypes | `${TransactionTypes}`;
  kind: TransactionKind | `${TransactionKind}`;
  uuid: CreationOptional<string>;
  description: string;
  amount: number;
  currency: SupportedCurrency;
  hostCurrency: SupportedCurrency;
  hostCurrencyFxRate: number;
  netAmountInCollectiveCurrency: number;
  amountInHostCurrency: number;
  hostFeeInHostCurrency: number | null;
  paymentProcessorFeeInHostCurrency: number | null;
  platformFeeInHostCurrency: number | null;
  taxAmount: number | null;
  data: TransactionData | null;
  TransactionGroup: string;
  isRefund: boolean;
  isDebt: boolean;
  isDisputed: boolean;
  isInReview: boolean;
  isInternal: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
  /** The effective date the transaction was settled outside the platform, in the account it transacted. */
  clearedAt: Date;

  // Foreign keys
  CreatedByUserId: number;
  FromCollectiveId: number;
  CollectiveId: number;
  HostCollectiveId: number;
  UsingGiftCardFromCollectiveId: number;
  OrderId: number;
  ExpenseId: number;
  PayoutMethodId: number;
  PaymentMethodId: number;
  RefundTransactionId: number;

  // Associations
  createdByUser?: User;
  fromCollective?: Collective;
  host?: Collective;
  usingGiftCardFromCollective?: Collective;
  collective?: Collective;
  PaymentMethod?: PaymentMethodModelInterface;
  PayoutMethod?: PayoutMethod;
  Order?: OrderModelInterface;

  // Getter Methods
  info: Partial<TransactionInterface>;
  merchantId?: string;

  // Class methods
  getHostCollective: (options?: { loaders?: any }) => Promise<Collective>;
  getCollective: () => Promise<Collective | null>;
  getOrder: (options?: { paranoid?: boolean }) => Promise<OrderModelInterface | null>;
  hasPlatformTip: () => boolean;
  getRelatedTransaction: (options: { type?: string; kind?: string; isDebt?: boolean }) => Promise<TransactionInterface>;
  getOppositeTransaction: () => Promise<TransactionInterface | null>;
  getPaymentProcessorFeeTransaction: () => Promise<TransactionInterface | null>;
  getTaxTransaction: () => Promise<TransactionInterface | null>;
  getPlatformTipTransaction: () => Promise<TransactionInterface | null>;
  getPlatformTipDebtTransaction: () => Promise<TransactionInterface | null>;
  getHostFeeTransaction: () => Promise<TransactionInterface | null>;
  getHostFeeShareTransaction: () => Promise<TransactionInterface | null>;
  getHostFeeShareDebtTransaction: () => Promise<TransactionInterface | null>;
  getRefundTransaction: () => Promise<TransactionInterface | null>;
  getGiftCardEmitterCollective: () => Promise<Collective | null>;
  getSource: () => Promise<Collective | null>;
  getUser: () => Promise<User | null>;
  setCurrency: (currency: SupportedCurrency) => Promise<TransactionInterface>;
  paymentMethodProviderCollectiveId: () => number;
}

// Ideally, this should be `InferCreationAttributes<TransactionInterface>` but for some reason
// Typescript is not respecting the `CreationOptional` type and makes all attributes required.
export type TransactionCreationAttributes = Partial<TransactionInterface>;

interface TransactionModelStaticInterface {
  updateCurrency(currency: SupportedCurrency, transaction: TransactionInterface): Promise<TransactionInterface>;
  createMany(
    transactions: TransactionCreationAttributes[],
    defaultValues?: TransactionCreationAttributes,
  ): Promise<TransactionInterface[] | void>;
  createManyDoubleEntry(
    transactions: TransactionCreationAttributes[],
    defaultValues?: TransactionCreationAttributes,
  ): Promise<TransactionInterface[] | void>;
  createDoubleEntry(transaction: TransactionCreationAttributes, opts?: any): Promise<TransactionInterface>;
  exportCSV(transactions: TransactionInterface[], collectivesById: Record<number, Collective>): string;

  getFxRate(
    fromCurrency: SupportedCurrency,
    toCurrency: SupportedCurrency,
    transaction?: TransactionInterface | TransactionCreationAttributes,
  ): Promise<number>;
  calculateNetAmountInCollectiveCurrency(transaction: TransactionInterface | TransactionCreationAttributes): number;
  canHaveFees(transaction: Partial<TransactionInterface>): boolean;
  assertAmountsLooselyEqual(a: number, b: number, message?: string): void;
  assertAmountsStrictlyEqual(a: number, b: number, message?: string): void;
  calculateNetAmountInHostCurrency(transaction: TransactionInterface): number;
  validateContributionPayload(payload: TransactionCreationAttributes): void;
  getPaymentProcessorFeeVendor(service: string): Promise<Collective>;
  getTaxVendor(taxId: string): Promise<Collective>;
  createActivity(
    transaction: TransactionInterface,
    options?: { sequelizeTransaction?: SequelizeTransaction },
  ): Promise<Activity | void>;
  createPlatformTipTransactions(transaction: TransactionCreationAttributes): Promise<void | {
    transaction: TransactionCreationAttributes;
    platformTipTransaction: TransactionInterface;
    platformTipDebtTransaction: TransactionInterface;
  }>;
  createPlatformTipDebtTransactions(args: {
    platformTipTransaction: TransactionInterface;
    transaction: TransactionCreationAttributes;
  }): Promise<TransactionInterface>;
  createPaymentProcessorFeeTransactions(
    transaction: TransactionCreationAttributes,
    data?: TransactionData,
  ): Promise<{
    /** The original transaction, potentially modified if a payment processor fees was set */
    transaction: TransactionInterface | TransactionCreationAttributes;
    /** The payment processor fee transaction */
    paymentProcessorFeeTransaction: TransactionInterface;
  } | void>;
  createTaxTransactions(
    transaction: TransactionCreationAttributes,
    data?: TransactionData,
  ): Promise<{
    /** The original transaction, potentially modified if a tax was set */
    transaction: TransactionInterface | TransactionCreationAttributes;
    /** The tax transaction */
    taxTransaction: TransactionInterface;
  } | void>;
  createHostFeeTransactions(
    transaction: TransactionCreationAttributes,
    data?: TransactionData,
  ): Promise<{
    transaction: TransactionInterface | TransactionCreationAttributes;
    hostFeeTransaction: TransactionInterface;
  } | void>;
  createHostFeeShareTransactions(params: {
    transaction: TransactionCreationAttributes;
    hostFeeTransaction: TransactionInterface;
  }): Promise<{
    hostFeeShareTransaction: TransactionInterface;
    hostFeeShareDebtTransaction: TransactionInterface;
  } | void>;
  createHostFeeShareDebtTransactions(params: {
    hostFeeShareTransaction: TransactionInterface;
  }): Promise<TransactionInterface>;
  createFromContributionPayload(transaction: TransactionCreationAttributes): Promise<TransactionInterface>;
  validate(
    transaction: TransactionInterface | TransactionCreationAttributes,
    opts?: { validateOppositeTransaction?: boolean; oppositeTransaction?: TransactionInterface },
  ): void;
  fetchHost(transaction: TransactionInterface | TransactionCreationAttributes): Promise<Collective | null>;
}

const Transaction: ModelStatic<TransactionInterface> & TransactionModelStaticInterface = sequelize.define(
  'Transaction',
  {
    type: DataTypes.STRING, // DEBIT or CREDIT

    kind: {
      allowNull: true,
      type: DataTypes.ENUM(...Object.values(TransactionKind)),
    },

    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true,
    },

    description: DataTypes.STRING,
    amount: DataTypes.INTEGER,

    currency: CustomDataTypes(DataTypes).currency,

    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // we allow CreatedByUserId to be null but only on refund transactions
      validate: {
        isValid(value) {
          if (isNull(value) && this.isRefund === false) {
            throw new Error('Only refund transactions can have null user.');
          }
        },
      },
    },

    // Source of the money for a DEBIT
    // Recipient of the money for a CREDIT
    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // when a host adds funds, we need to create a transaction to add money to the system (to the host collective)
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    // Keeps a reference to the host because this is where the bank account is
    // Note that the host can also change over time (that's why just keeping CollectiveId is not enough)
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // the opposite transaction that records the CREDIT to the User that submitted an expense doesn't have a HostCollectiveId, see https://github.com/opencollective/opencollective/issues/1154
    },

    UsingGiftCardFromCollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    OrderId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Orders',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    // Refactor: an Expense should be an Order
    ExpenseId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Expenses',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    // stores the currency that the transaction happened in (currency of the host)
    hostCurrency: {
      type: DataTypes.STRING,
      set(val: string) {
        if (val && val.toUpperCase) {
          this.setDataValue('hostCurrency', val.toUpperCase());
        }
      },
    },

    // stores the foreign exchange rate at the time of transaction between donation currency and transaction currency
    // amountInCollectiveCurrency * hostCurrencyFxRate = amountInHostCurrency
    // Expense amount * hostCurrencyFxRate = amountInHostCurrency
    hostCurrencyFxRate: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 1,
    },

    // amount in currency of the host
    amountInHostCurrency: DataTypes.INTEGER,
    platformFeeInHostCurrency: DataTypes.INTEGER,
    hostFeeInHostCurrency: DataTypes.INTEGER,
    paymentProcessorFeeInHostCurrency: DataTypes.INTEGER,

    // amount in transaction currency
    taxAmount: { type: DataTypes.INTEGER },

    /**
     * TODO: Rename this field, as it's always expressed with `currency`. It should just be `netAmount`
     */
    netAmountInCollectiveCurrency: DataTypes.INTEGER, // stores the net amount received by the collective (after fees) or removed from the collective (including fees)

    data: DataTypes.JSONB,

    // Note: Not a foreign key, should have been lower case t, 'transactionGroup`
    TransactionGroup: {
      type: DataTypes.UUID,
    },

    RefundTransactionId: {
      type: DataTypes.INTEGER,
      references: { model: 'Transactions', key: 'id' },
    },

    PaymentMethodId: {
      type: DataTypes.INTEGER,
      references: { model: 'PaymentMethods', key: 'id' },
      allowNull: true,
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    PayoutMethodId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'PayoutMethods' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    isRefund: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isDebt: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },

    isDisputed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isInReview: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isInternal: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    deletedAt: {
      type: DataTypes.DATE,
    },

    clearedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    /** A virtual field to make working with settlements easier. Must be preloaded manually. */
    settlementStatus: {
      type: DataTypes.VIRTUAL,
    },
  },
  {
    paranoid: true,

    getterMethods: {
      netAmountInHostCurrency() {
        return Transaction.calculateNetAmountInHostCurrency(this);
      },

      amountSentToHostInHostCurrency() {
        return this.amountInHostCurrency + this.paymentProcessorFeeInHostCurrency + this.platformFeeInHostCurrency;
      },

      // Info.
      // Warning: Only add public fields in there, as the raw object is shared through webhooks
      info() {
        return {
          id: this.id,
          uuid: this.uuid,
          group: this.TransactionGroup,
          type: this.type,
          kind: this.kind,
          description: this.description,
          amount: this.amount,
          currency: this.currency,
          createdAt: this.createdAt,
          clearedAt: this.clearedAt,
          CreatedByUserId: this.CreatedByUserId,
          FromCollectiveId: this.FromCollectiveId,
          CollectiveId: this.CollectiveId,
          UsingGiftCardFromCollectiveId: this.UsingGiftCardFromCollectiveId,
          platformFee: this.platformFee,
          platformFeeInHostCurrency: this.platformFeeInHostCurrency,
          hostFee: this.hostFee,
          hostFeeInHostCurrency: this.hostFeeInHostCurrency,
          paymentProcessorFeeInHostCurrency: this.paymentProcessorFeeInHostCurrency,
          amountInHostCurrency: this.amountInHostCurrency,
          netAmountInCollectiveCurrency: this.netAmountInCollectiveCurrency,
          netAmountInHostCurrency: this.netAmountInHostCurrency,
          amountSentToHostInHostCurrency: this.amountSentToHostInHostCurrency,
          taxAmount: this.taxAmount,
          hostCurrency: this.hostCurrency,
          ExpenseId: this.ExpenseId,
          OrderId: this.OrderId,
          isRefund: this.isRefund,
          isDebt: this.isDebt,
        };
      },

      merchantId() {
        return head(compact(MERCHANT_ID_PATHS[this.kind]?.map(path => get(this, path))));
      },
    },

    hooks: {
      afterCreate: transaction => {
        if (shouldGenerateTransactionActivities(transaction.CollectiveId)) {
          Transaction.createActivity(transaction);
        }

        // intentionally returns null, needs to be async
        return null;
      },
    },
  },
);

/**
 * Instance Methods
 */
Transaction.prototype.getUser = function () {
  return User.findByPk(this.CreatedByUserId);
};

Transaction.prototype.getGiftCardEmitterCollective = function () {
  if (this.UsingGiftCardFromCollectiveId) {
    return Collective.findByPk(this.UsingGiftCardFromCollectiveId);
  }
};

Transaction.prototype.getHostCollective = async function ({ loaders = undefined } = {}) {
  let HostCollectiveId = this.HostCollectiveId;
  // if the transaction is from the perspective of the fromCollective
  if (!HostCollectiveId) {
    const fromCollective = loaders
      ? await loaders.Collective.byId.load(this.FromCollectiveId)
      : await Collective.findByPk(this.FromCollectiveId);
    HostCollectiveId = await fromCollective.getHostCollectiveId();
  }
  return loaders ? loaders.Collective.byId.load(HostCollectiveId) : Collective.findByPk(HostCollectiveId);
};

Transaction.prototype.getSource = function () {
  if (this.OrderId) {
    return this.getOrder({ paranoid: false });
  }
  if (this.ExpenseId) {
    return this.getExpense({ paranoid: false });
  }
};

/**
 * Returns the transaction payment method provider collective ID, which is
 * either the gift card provider if using a gift card or
 * `CollectiveId` otherwise.
 */
Transaction.prototype.paymentMethodProviderCollectiveId = function () {
  if (this.UsingGiftCardFromCollectiveId) {
    return this.UsingGiftCardFromCollectiveId;
  }
  return this.type === 'DEBIT' ? this.CollectiveId : this.FromCollectiveId;
};

Transaction.prototype.getRefundTransaction = function (): Promise<TransactionInterface | null> {
  if (!this.RefundTransactionId) {
    return null;
  }
  return Transaction.findByPk(this.RefundTransactionId);
};

Transaction.prototype.hasPlatformTip = function (): boolean {
  return Boolean(
    this.data?.hasPlatformTip &&
      this.kind !== TransactionKind.PLATFORM_TIP &&
      this.kind !== TransactionKind.PLATFORM_TIP_DEBT,
  );
};

Transaction.prototype.getRelatedTransaction = function (
  options: Pick<TransactionInterface, 'type' | 'kind' | 'isDebt'>,
): Promise<TransactionInterface | null> {
  return Transaction.findOne({
    where: {
      TransactionGroup: this.TransactionGroup,
      type: options.type || this.type,
      kind: options.kind || this.kind,
      isDebt: options.isDebt || { [Op.not]: true },
    },
  });
};

Transaction.prototype.getPaymentProcessorFeeTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.PAYMENT_PROCESSOR_FEE });
};

Transaction.prototype.getTaxTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.TAX });
};

Transaction.prototype.getPlatformTipTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.PLATFORM_TIP });
};

Transaction.prototype.getPlatformTipDebtTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.PLATFORM_TIP_DEBT, isDebt: true });
};

Transaction.prototype.getHostFeeTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.HOST_FEE });
};

Transaction.prototype.getHostFeeShareTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.HOST_FEE_SHARE });
};

Transaction.prototype.getHostFeeShareDebtTransaction = function () {
  return this.getRelatedTransaction({ kind: TransactionKind.HOST_FEE_SHARE_DEBT, isDebt: true });
};

Transaction.prototype.getOppositeTransaction = async function () {
  return this.getRelatedTransaction({ type: this.type === CREDIT ? DEBIT : CREDIT, isDebt: this.isDebt });
};

Transaction.prototype.setCurrency = async function (currency) {
  // Nothing to do
  if (currency === this.currency) {
    return this;
  }

  await Transaction.updateCurrency(currency, this);

  return this.save();
};

/**
 * Class Methods
 */
Transaction.createMany = (transactions: TransactionCreationAttributes[], defaultValues) => {
  return Promise.all(
    transactions.map(transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.create(transaction) as Promise<TransactionInterface>;
    }),
  ).catch(error => {
    console.error(error);
    reportErrorToSentry(error);
  });
};

Transaction.createManyDoubleEntry = (transactions: TransactionCreationAttributes[], defaultValues) => {
  return Promise.all(
    transactions.map(transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.createDoubleEntry(transaction) as Promise<TransactionInterface>;
    }),
  ).catch(error => {
    console.error(error);
    reportErrorToSentry(error);
  });
};

Transaction.exportCSV = (transactions, collectivesById) => {
  const getColumnName = attr => {
    if (attr === 'CollectiveId') {
      return 'collective';
    }
    if (attr === 'Expense.privateMessage') {
      return 'private note';
    } else {
      return attr;
    }
  };

  const processValue = (attr, value) => {
    if (attr === 'CollectiveId') {
      return get(collectivesById[value], 'slug');
    } else if (attr === 'createdAt') {
      return moment(value).format('YYYY-MM-DD');
    } else if (attr === 'Expense.privateMessage') {
      return value && stripHTML(value);
    } else if (
      [
        'amount',
        'netAmountInCollectiveCurrency',
        'paymentProcessorFeeInHostCurrency',
        'hostFeeInHostCurrency',
        'platformFeeInHostCurrency',
        'netAmountInHostCurrency',
        'amountInHostCurrency',
        'taxAmount',
      ].indexOf(attr) !== -1
    ) {
      return value / 100; // converts cents
    }
    return value;
  };

  const attributes = [
    'id',
    'createdAt',
    'type',
    'CollectiveId',
    'amount',
    'amountInHostCurrency',
    'currency',
    'description',
    'netAmountInCollectiveCurrency',
    'hostCurrency',
    'hostCurrencyFxRate',
    'paymentProcessorFeeInHostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'netAmountInHostCurrency',
    'Expense.privateMessage',
    'source',
    'isRefund',
  ];

  // We only add tax amount for relevant hosts (subject to VAT or GST)
  const mightHaveTaxes = transaction => transaction.taxAmount || ['NZD', 'EUR'].includes(transaction.hostCurrency);
  if (transactions.some(mightHaveTaxes)) {
    attributes.splice(5, 0, 'taxAmount');
  }

  return exportToCSV(transactions, attributes, getColumnName, processValue);
};

/**
 * Create the opposite transaction from the perspective of the FromCollective
 * There is no fees
 * @POST Two transactions are created. Returns the initial transaction FromCollectiveId -> CollectiveId
 *
 * Examples (simplified with rounded numbers):
 * - Expense1 from User1 paid by Collective1
 *   - amount: $10
 *   - PayPal Fees: $1
 *   - Host Fees: $0
 *   - Platform Fees: $0
 *   => DEBIT: Collective: C1, FromCollective: U1
 *      amount: -$10, netAmountInCollectiveCurrency: -$11, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: 0, hostFeeInHostCurrency: 0
 *   => CREDIT: Collective: U1, FromCollective: C1
 *      amount: $11, netAmountInCollectiveCurrency: $10, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: 0, hostFeeInHostCurrency: 0
 *
 * - Donation1 from User1 to Collective1
 *   - amount: $10
 *   - Stripe Fees: $1
 *   - Host Fees: $1
 *   - Platform Fees: $1
 *   => DEBIT: Collective: U1, FromCollective: C1
 *      amount: -$7, netAmountInCollectiveCurrency: -$10, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: -$1, hostFeeInHostCurrency: -$1
 *   => CREDIT: Collective: C1, FromCollective: U1
 *      amount: $10, netAmountInCollectiveCurrency: $7, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: -$1, hostFeeInHostCurrency: -$1
 *
 * Note:
 * We should simplify a Transaction to:
 * CollectiveId, DEBIT/CREDIT, amount, currency, OrderId where amount is always the net amount in the currency of CollectiveId
 * and we should move paymentProcessorFee, platformFee, hostFee to the Order model
 *
 */
Transaction.createDoubleEntry = async (transaction: TransactionCreationAttributes): Promise<TransactionInterface> => {
  // Force transaction type based on amount sign
  if (transaction.amount > 0) {
    transaction.type = CREDIT;
  } else if (transaction.amount < 0) {
    transaction.type = DEBIT;
  } else if (!transaction.type) {
    throw new Error('Transaction type must be set when amount is 0');
  }

  if (transaction.kind === EXPENSE && transaction.type === CREDIT && !transaction.isRefund) {
    throw new Error('Transaction kind=EXPENSE should be initiated as a DEBIT transaction.');
  } else if (transaction.kind === CONTRIBUTION && transaction.type === DEBIT && !transaction.isRefund) {
    throw new Error('Transaction kind=CONTRIBUTION should be initiated as a CREDIT transaction.');
  }
  // TODO: should we check for refunds also?

  transaction.netAmountInCollectiveCurrency = transaction.netAmountInCollectiveCurrency || transaction.amount;
  // transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);
  transaction.TransactionGroup = transaction.TransactionGroup || uuid();
  transaction.hostCurrencyFxRate = transaction.hostCurrencyFxRate || 1;

  // Create Platform Tip transaction
  if (transaction.data?.platformTip) {
    // Separate donation transaction and remove platformTip from the main transaction
    const result = await Transaction.createPlatformTipTransactions(transaction);
    // Transaction was modified by createPlatformTipTransactions, we get it from the result
    if (result && result.transaction) {
      transaction = result.transaction;
    }
  }

  // Create Host Fee Transaction
  if (transaction.hostFeeInHostCurrency) {
    const result = await Transaction.createHostFeeTransactions(transaction);
    if (result) {
      if (result.hostFeeTransaction) {
        await Transaction.createHostFeeShareTransactions({
          transaction: result.transaction,
          hostFeeTransaction: result.hostFeeTransaction,
        });
      }
      // Transaction was modified by createHostFeeTransaction, we get it from the result
      if (result.transaction) {
        transaction = result.transaction;
      }
    }
  }

  // Create Tax transaction
  if (transaction.taxAmount && parseToBoolean(config.ledger.separateTaxes) === true) {
    const result = await Transaction.createTaxTransactions(transaction);
    if (result) {
      // Transaction was modified by createTaxTransactions, we get it from the result
      transaction = result.transaction;
    }
  }

  // Create Payment Processor Fee transaction
  if (
    transaction.paymentProcessorFeeInHostCurrency &&
    parseToBoolean(config.ledger.separatePaymentProcessorFees) === true
  ) {
    const result = await Transaction.createPaymentProcessorFeeTransactions(transaction);
    if (result) {
      // Transaction was modified by paymentProcessorFeeTransactions, we get it from the result
      transaction = result.transaction;
    }
  }

  // If FromCollectiveId = CollectiveId, we only create one transaction (DEBIT or CREDIT)
  if (transaction.FromCollectiveId === transaction.CollectiveId) {
    return Transaction.create(transaction) as Promise<TransactionInterface>;
  }

  if (!isUndefined(transaction.amountInHostCurrency)) {
    // ensure this is always INT
    transaction.amountInHostCurrency = Math.round(transaction.amountInHostCurrency);
  }

  const fromCollective = await Collective.findByPk(transaction.FromCollectiveId);
  const fromCollectiveHost = await fromCollective.getHostCollective();

  let oppositeTransaction = {
    ...transaction,
    type: transaction.type === DEBIT ? CREDIT : DEBIT,
    FromCollectiveId: transaction.CollectiveId,
    CollectiveId: transaction.FromCollectiveId,
  };

  if (!fromCollective.isActive || !fromCollectiveHost) {
    oppositeTransaction = {
      ...oppositeTransaction,
      HostCollectiveId: null,
      amount: -transaction.netAmountInCollectiveCurrency,
      netAmountInCollectiveCurrency: -transaction.amount,
      amountInHostCurrency: Math.round(-transaction.netAmountInCollectiveCurrency * transaction.hostCurrencyFxRate),

      hostFeeInHostCurrency: transaction.hostFeeInHostCurrency,
      platformFeeInHostCurrency: transaction.platformFeeInHostCurrency,
      paymentProcessorFeeInHostCurrency: transaction.paymentProcessorFeeInHostCurrency,
    };
  } else {
    // Is the target "collective" (account) "Active" (has an host, manage its own budget)
    const hostCurrency = fromCollectiveHost.currency;
    const hostCurrencyFxRate = await Transaction.getFxRate(transaction.currency, hostCurrency, transaction);
    const oppositeTransactionHostCurrencyFxRate = await Transaction.getFxRate(
      transaction.hostCurrency,
      hostCurrency,
      transaction,
    );

    oppositeTransaction = {
      ...oppositeTransaction,
      // TODO: credit card transactions (and similar) should not be marked with the HostCollectiveId
      //       only Collective to Collective (and such) should be
      HostCollectiveId: fromCollectiveHost.id,
      hostCurrency,
      hostCurrencyFxRate,
      amount: -Math.round(transaction.netAmountInCollectiveCurrency),
      netAmountInCollectiveCurrency: -Math.round(transaction.amount),
      amountInHostCurrency: -Math.round(transaction.netAmountInCollectiveCurrency * hostCurrencyFxRate),
      hostFeeInHostCurrency: Math.round(transaction.hostFeeInHostCurrency * oppositeTransactionHostCurrencyFxRate),
      platformFeeInHostCurrency: Math.round(
        transaction.platformFeeInHostCurrency * oppositeTransactionHostCurrencyFxRate,
      ),
      paymentProcessorFeeInHostCurrency: Math.round(
        transaction.paymentProcessorFeeInHostCurrency * oppositeTransactionHostCurrencyFxRate,
      ),
      data: { ...omit(transaction.data, ['hostToPlatformFxRate']), oppositeTransactionHostCurrencyFxRate },
    };

    // Also keep rate on original transaction
    transaction.data = {
      ...transaction.data,
      oppositeTransactionHostCurrencyFxRate: 1 / oppositeTransactionHostCurrencyFxRate,
    };

    // Handle Host Fee when paying an Expense between Hosts
    // TODO: This should not be part of `createDoubleEntry`, maybe `createTransactionsFromPaidExpense`?
    if (oppositeTransaction.kind === 'EXPENSE' && !oppositeTransaction.isRefund) {
      const collective = await Collective.findByPk(transaction.CollectiveId);
      const collectiveHost = await collective.getHostCollective();
      if (collectiveHost.id !== fromCollectiveHost.id) {
        const hostFeePercent = fromCollective.isHostAccount ? 0 : fromCollective.hostFeePercent;
        const taxAmountInHostCurrency = Math.round((transaction.taxAmount || 0) * hostCurrencyFxRate);
        oppositeTransaction.hostFeeInHostCurrency = calcFee(
          oppositeTransaction.amountInHostCurrency +
            oppositeTransaction.paymentProcessorFeeInHostCurrency +
            taxAmountInHostCurrency,
          hostFeePercent,
        );
        if (oppositeTransaction.hostFeeInHostCurrency) {
          await Transaction.createHostFeeTransactions(oppositeTransaction);
        }
      }
    }
  }

  debug('createDoubleEntry', transaction, 'opposite', oppositeTransaction);

  // We first record the negative transaction
  // and only then we can create the transaction to add money somewhere else
  if (transaction.type === DEBIT) {
    const t = await Transaction.create(transaction);
    await Transaction.create(oppositeTransaction);
    return t;
  } else {
    await Transaction.create(oppositeTransaction);
    return Transaction.create(transaction);
  }
};

/**
 * Record a debt transaction and its associated settlement
 */
Transaction.createPlatformTipDebtTransactions = async ({
  platformTipTransaction,
  transaction,
}: {
  platformTipTransaction: TransactionInterface;
  transaction: TransactionCreationAttributes;
}): Promise<TransactionInterface> => {
  if (platformTipTransaction.type === DEBIT) {
    throw new Error('createPlatformTipDebtTransactions must be given a CREDIT transaction');
  }

  // This should be the host of the original transaction
  const host = await Transaction.fetchHost(transaction);

  // Create debt transaction
  const platformTipDebtTransactionData = {
    // Copy base values from the original CREDIT PLATFORM_TIP
    ...pick(platformTipTransaction.dataValues, [
      'TransactionGroup',
      'CollectiveId',
      'HostCollectiveId',
      'OrderId',
      'createdAt',
      'clearedAt',
      'currency',
      'hostCurrency',
      'hostCurrencyFxRate',
    ]),
    type: DEBIT,
    kind: TransactionKind.PLATFORM_TIP_DEBT,
    isDebt: true,
    description: 'Platform Tip collected for Open Collective',
    FromCollectiveId: host.id,
    // Opposite amounts
    amount: -platformTipTransaction.amount,
    netAmountInCollectiveCurrency: -platformTipTransaction.netAmountInCollectiveCurrency,
    amountInHostCurrency: -platformTipTransaction.amountInHostCurrency,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
  };

  const platformTipDebtTransaction = await Transaction.createDoubleEntry(platformTipDebtTransactionData);

  // Create settlement
  const settlementStatus = TransactionSettlementStatus.OWED;
  await TransactionSettlement.createForTransaction(platformTipDebtTransaction, settlementStatus);

  return platformTipDebtTransaction;
};

/**
 * Creates platform tip transactions from a given transaction.
 * @param {Transaction} The actual transaction
 * @param {Collective} The host
 * @param {boolean} Whether tip has been collected already (no debt needed)
 */
Transaction.createPlatformTipTransactions = async (
  transaction: TransactionCreationAttributes,
): Promise<void | {
  transaction: TransactionCreationAttributes;
  platformTipTransaction: TransactionInterface;
  platformTipDebtTransaction: TransactionInterface | null;
}> => {
  const platformTip = transaction.data?.platformTip;
  if (!platformTip) {
    return;
  }

  // amount of the CREDIT should be in the same currency as the original transaction
  const amount = platformTip;
  const currency = transaction.currency;

  // amountInHostCurrency of the CREDIT should be in platform currency
  const hostCurrency = PLATFORM_TIP_TRANSACTION_PROPERTIES.currency;
  const hostCurrencyFxRate = await Transaction.getFxRate(currency, hostCurrency, transaction);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);

  // we compute the Fx Rate between the original hostCurrency and the platform currency
  // it might be used later
  const hostToPlatformFxRate = await Transaction.getFxRate(
    transaction.hostCurrency,
    PLATFORM_TIP_TRANSACTION_PROPERTIES.currency,
    transaction,
  );

  const platformTipTransactionData = {
    ...pick(transaction, [
      'TransactionGroup',
      'FromCollectiveId',
      'OrderId',
      'CreatedByUserId',
      'PaymentMethodId',
      'UsingGiftCardFromCollectiveId',
      'clearedAt',
    ]),
    type: CREDIT,
    kind: TransactionKind.PLATFORM_TIP,
    description: 'Financial contribution to Open Collective',
    CollectiveId: PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId,
    HostCollectiveId: PLATFORM_TIP_TRANSACTION_PROPERTIES.HostCollectiveId,
    // Compute Amounts
    amount,
    netAmountInCollectiveCurrency: amount,
    currency,
    amountInHostCurrency,
    hostCurrency,
    hostCurrencyFxRate,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    // Extra data
    isDebt: false,
    data: {
      hostToPlatformFxRate,
    },
  };

  const platformTipTransaction = await Transaction.createDoubleEntry(platformTipTransactionData);

  let platformTipDebtTransaction;
  if (!transaction.data.isPlatformRevenueDirectlyCollected) {
    platformTipDebtTransaction = await Transaction.createPlatformTipDebtTransactions({
      platformTipTransaction,
      transaction,
    });
  }

  // If we have platformTipInHostCurrency available, we trust it, otherwise we compute it
  const platformTipInHostCurrency =
    <number>transaction.data?.platformTipInHostCurrency || Math.round(platformTip * transaction.hostCurrencyFxRate);

  // Recalculate amount
  transaction.amountInHostCurrency = Math.round(transaction.amountInHostCurrency - platformTipInHostCurrency);
  transaction.amount = Math.round(transaction.amount - platformTip);

  // Reset the platformFee because we're accounting for this value in a separate set of transactions
  // This way of passing tips is deprecated but still used in some older tests
  transaction.platformFeeInHostCurrency = 0;
  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return { transaction, platformTipTransaction, platformTipDebtTransaction };
};

Transaction.validateContributionPayload = (payload: TransactionCreationAttributes): void => {
  if (!payload.amount || typeof payload.amount !== 'number' || payload.amount < 0) {
    throw new Error('amount should be set and positive');
  }
  if (!payload.currency) {
    throw new Error('currency should be set');
  }
  if (
    payload.hostCurrency &&
    (!payload.amountInHostCurrency ||
      typeof payload.amountInHostCurrency !== 'number' ||
      payload.amountInHostCurrency < 0)
  ) {
    throw new Error('amountInHostCurrency should be set and positive');
  }
  if (payload.amountInHostCurrency && !payload.hostCurrency) {
    throw new Error('hostCurrency should be set');
  }
  if (payload.type && payload.type !== 'CREDIT') {
    throw new Error('type should be null or CREDIT');
  }
  if (!isNil(payload.netAmountInCollectiveCurrency)) {
    throw new Error('netAmountInCollectiveCurrency should not be set');
  }
};

Transaction.createHostFeeTransactions = async (
  transaction: TransactionCreationAttributes,
  data?: TransactionData,
): Promise<{ transaction: TransactionCreationAttributes; hostFeeTransaction: TransactionInterface } | void> => {
  if (!transaction.hostFeeInHostCurrency) {
    return;
  }

  const host = await Transaction.fetchHost(transaction);

  // The reference value is currently passed as "hostFeeInHostCurrency"
  const amountInHostCurrency = Math.abs(transaction.hostFeeInHostCurrency);
  const hostCurrency = transaction.hostCurrency;
  const hostCurrencyFxRate = transaction.hostCurrencyFxRate;

  // For the Collective/Fund, we calculate the matching amount using the hostCurrencyFxRate
  const amount = Math.round(amountInHostCurrency / transaction.hostCurrencyFxRate);
  const currency = transaction.currency;

  const hostFeeTransactionData = {
    type: CREDIT,
    kind: TransactionKind.HOST_FEE,
    description: 'Host Fee',
    TransactionGroup: transaction.TransactionGroup,
    FromCollectiveId: transaction.CollectiveId,
    CollectiveId: host.id,
    HostCollectiveId: host.id,
    // Compute amounts
    amount,
    netAmountInCollectiveCurrency: amount,
    currency: currency,
    amountInHostCurrency: amountInHostCurrency,
    hostCurrency: hostCurrency,
    hostCurrencyFxRate: hostCurrencyFxRate,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    OrderId: transaction.OrderId,
    createdAt: transaction.createdAt,
    clearedAt: transaction.clearedAt || transaction.createdAt,
    data,
  };

  const hostFeeTransaction = await Transaction.createDoubleEntry(hostFeeTransactionData);

  // Reset the original host fee because we're now accounting for this value in a separate set of transactions
  transaction.hostFeeInHostCurrency = 0;
  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return { transaction, hostFeeTransaction };
};

/**
 * Returns the Vendor account associated with a payment processor service. This function is memoized as
 * the processor fee vendor will not change during the lifetime of the server.
 */
Transaction.getPaymentProcessorFeeVendor = memoize(
  async (service: PAYMENT_METHOD_SERVICE | PayoutMethodTypes | 'OTHER'): Promise<Collective> => {
    const vendorSlugs = {
      // Stripe
      [PAYMENT_METHOD_SERVICE.STRIPE]: 'stripe-payment-processor-vendor',
      // Paypal
      [PAYMENT_METHOD_SERVICE.PAYPAL]: 'paypal-payment-processor-vendor',
      [PayoutMethodTypes.PAYPAL]: 'paypal-payment-processor-vendor',
      // Wise
      [PayoutMethodTypes.BANK_ACCOUNT]: 'wise-payment-processor-vendor',
      // Manual
      OTHER: 'other-payment-processor-vendor',
    };

    return Collective.findBySlug(vendorSlugs[service] || vendorSlugs['OTHER']);
  },
);

Transaction.createPaymentProcessorFeeTransactions = async (
  transaction: TransactionCreationAttributes,
  data: Record<string, unknown> | null = null,
): Promise<{
  /** The original transaction, potentially modified if a payment processor fees was set */
  transaction: TransactionCreationAttributes;
  /** The payment processor fee transaction */
  paymentProcessorFeeTransaction: TransactionInterface;
} | void> => {
  if (!transaction.paymentProcessorFeeInHostCurrency) {
    return;
  }

  const paymentMethod = transaction.PaymentMethodId && (await PaymentMethod.findByPk(transaction.PaymentMethodId));
  const payoutMethod = transaction.PayoutMethodId && (await PayoutMethod.findByPk(transaction.PayoutMethodId));
  let service = paymentMethod?.service || payoutMethod?.type || 'OTHER';
  if (service === PayoutMethodTypes.BANK_ACCOUNT && !data?.transfer) {
    service = 'OTHER';
  }

  const vendor = await Transaction.getPaymentProcessorFeeVendor(service);

  // The reference value is currently passed as "hostFeeInHostCurrency"
  const amountInHostCurrency = Math.abs(transaction.paymentProcessorFeeInHostCurrency);
  const hostCurrency = transaction.hostCurrency;
  const hostCurrencyFxRate = transaction.hostCurrencyFxRate;

  // For the Collective/Fund, we calculate the matching amount using the hostCurrencyFxRate
  const amount = Math.round(amountInHostCurrency / transaction.hostCurrencyFxRate);
  const currency = transaction.currency;

  const paymentProcessorFeeTransactionData = {
    type: CREDIT,
    kind: TransactionKind.PAYMENT_PROCESSOR_FEE,
    description: `${vendor.name} payment processor fee`,
    TransactionGroup: transaction.TransactionGroup,
    FromCollectiveId: transaction.CollectiveId,
    CollectiveId: vendor.id,
    HostCollectiveId: null,
    // Compute amounts
    amount,
    netAmountInCollectiveCurrency: amount,
    currency: currency,
    amountInHostCurrency: amountInHostCurrency,
    hostCurrency: hostCurrency,
    hostCurrencyFxRate: hostCurrencyFxRate,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    OrderId: transaction.OrderId,
    ExpenseId: transaction.ExpenseId,
    PaymentMethodId: transaction.PaymentMethodId,
    PayoutMethodId: transaction.PayoutMethodId,
    createdAt: transaction.createdAt,
    clearedAt: transaction.clearedAt || transaction.createdAt,
    data,
  };

  const paymentProcessorFeeTransaction = await Transaction.createDoubleEntry(paymentProcessorFeeTransactionData);

  // Reset the original processor fee because we're now accounting for this value in a separate set of transactions
  transaction.paymentProcessorFeeInHostCurrency = 0;
  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return { transaction, paymentProcessorFeeTransaction };
};

/**
 * Returns the Vendor account associated with a given tax. This function is memoized as
 * the tax vendor will not change during the lifetime of the server.
 */
Transaction.getTaxVendor = memoize(async (taxId): Promise<Collective> => {
  const vendorByTaxId = {
    VAT: 'eu-vat-tax-vendor',
    GST: 'nz-gst-tax-vendor',
    OTHER: 'other-tax-vendor',
  };

  return Collective.findBySlug(vendorByTaxId[taxId] || vendorByTaxId['OTHER']);
});

/**
 * For contributions, the contributor pays the full amount then the tax is debited from the collective balance (to the TAX vendor)
 * For expenses, the collective pays the full amount to the payee, then the payee is debited from the tax amount (to the TAX vendor)
 */
Transaction.createTaxTransactions = async (
  transaction: TransactionCreationAttributes,
  data: Record<string, unknown> | null = null,
): Promise<{
  /** The original transaction, potentially modified if a payment processor fees was set */
  transaction: TransactionCreationAttributes;
  /** The payment processor fee transaction */
  taxTransaction: TransactionInterface;
} | void> => {
  if (!transaction.taxAmount) {
    return;
  } else if (transaction.kind === EXPENSE && transaction.type !== DEBIT) {
    throw new Error('createTaxTransactions should always be passed a DEBIT when kind=EXPENSE');
  }

  const tax: Tax | undefined = transaction.data?.tax;
  const taxId: string | undefined = tax?.id;
  const vendor = await Transaction.getTaxVendor(taxId);

  const amount = -transaction.taxAmount;
  const currency = transaction.currency;

  const hostCurrency = transaction.hostCurrency;
  const hostCurrencyFxRate = transaction.hostCurrencyFxRate;
  const amountInHostCurrency = -transaction.taxAmount * hostCurrencyFxRate;

  let FromCollectiveId, CollectiveId;
  if (!transaction.isRefund) {
    CollectiveId = vendor.id;
    if (transaction.kind === EXPENSE) {
      FromCollectiveId = transaction.FromCollectiveId;
    } else {
      FromCollectiveId = transaction.CollectiveId;
    }
  } else {
    // it's not likely to be used like this, as taxes are separated
    FromCollectiveId = vendor.id;
    if (transaction.kind === EXPENSE) {
      CollectiveId = transaction.FromCollectiveId;
    } else {
      CollectiveId = transaction.CollectiveId;
    }
  }

  const taxTransactionData = {
    type: CREDIT,
    kind: TransactionKind.TAX,
    description: `${vendor.name} tax`,
    TransactionGroup: transaction.TransactionGroup,
    FromCollectiveId,
    CollectiveId,
    HostCollectiveId: null,
    // Compute amounts
    amount,
    netAmountInCollectiveCurrency: amount,
    currency: currency,
    amountInHostCurrency: amountInHostCurrency,
    hostCurrency: hostCurrency,
    hostCurrencyFxRate: hostCurrencyFxRate,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    taxAmount: 0,
    OrderId: transaction.OrderId,
    ExpenseId: transaction.ExpenseId,
    isRefund: transaction.isRefund,
    CreatedByUserId: transaction.CreatedByUserId,
    createdAt: transaction.createdAt,
    clearedAt: transaction.clearedAt || transaction.createdAt,
    data: { ...data, ...pick(transaction.data, ['tax']) },
  };

  const taxTransaction = await Transaction.createDoubleEntry(taxTransactionData);

  // For expenses, tax needs to be added on top
  // amount: -10000, taxAmount: -2000 -> amount: -12000, taxAmount: 0
  if (transaction.kind === EXPENSE) {
    transaction.amount = transaction.amount + transaction.taxAmount;
    transaction.amountInHostCurrency = transaction.amount * transaction.hostCurrencyFxRate;
  }

  transaction.taxAmount = 0;
  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return { transaction, taxTransaction };
};

Transaction.createHostFeeShareTransactions = async ({
  transaction,
  hostFeeTransaction,
}: {
  transaction: TransactionInterface | TransactionCreationAttributes;
  hostFeeTransaction: TransactionInterface;
}): Promise<{
  hostFeeShareTransaction: TransactionInterface;
  hostFeeShareDebtTransaction: TransactionInterface;
} | void> => {
  const host = await Transaction.fetchHost(transaction);

  let hostFeeSharePercent = transaction.data?.hostFeeSharePercent;
  if (isNil(hostFeeSharePercent) && transaction.OrderId) {
    const order = await Order.findByPk(transaction.OrderId);
    hostFeeSharePercent = await getHostFeeSharePercent(order);
  }

  if (!hostFeeSharePercent) {
    return;
  }

  // Skip if missing or misconfigured
  const hostFeeShareCollective = await Collective.findByPk(HOST_FEE_SHARE_TRANSACTION_PROPERTIES.CollectiveId);
  const hostFeeShareHostCollective = await Collective.findByPk(HOST_FEE_SHARE_TRANSACTION_PROPERTIES.HostCollectiveId);
  if (!hostFeeShareCollective || !hostFeeShareHostCollective) {
    return;
  }

  // We use the Host Fee amountInHostCurrency/hostCurrency as a basis
  const amount = calcFee(hostFeeTransaction.amountInHostCurrency, hostFeeSharePercent);
  const currency = hostFeeTransaction.hostCurrency;

  // Skip if the amount is zero (e.g.: 15% * 0.03 = 0.0045 and rounded to 0)
  if (amount === 0) {
    return;
  }

  // This is a credit to Open Collective and needs to be inserted in USD
  const hostCurrency = HOST_FEE_SHARE_TRANSACTION_PROPERTIES.hostCurrency;
  const hostCurrencyFxRate = await Transaction.getFxRate(currency, hostCurrency, transaction);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);

  const hostFeeShareTransactionData = {
    type: CREDIT,
    kind: TransactionKind.HOST_FEE_SHARE,
    description: 'Host Fee Share',
    TransactionGroup: hostFeeTransaction.TransactionGroup,
    FromCollectiveId: host.id,
    CollectiveId: HOST_FEE_SHARE_TRANSACTION_PROPERTIES.CollectiveId,
    HostCollectiveId: HOST_FEE_SHARE_TRANSACTION_PROPERTIES.HostCollectiveId,
    // Compute amounts
    amount,
    netAmountInCollectiveCurrency: amount,
    currency,
    amountInHostCurrency,
    hostCurrency,
    hostCurrencyFxRate,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    OrderId: hostFeeTransaction.OrderId,
    createdAt: hostFeeTransaction.createdAt,
    clearedAt: hostFeeTransaction.clearedAt || hostFeeTransaction.createdAt,
  };

  const hostFeeShareTransaction = await Transaction.createDoubleEntry(hostFeeShareTransactionData);

  let hostFeeShareDebtTransaction;
  if (!transaction.data.isPlatformRevenueDirectlyCollected) {
    hostFeeShareDebtTransaction = await Transaction.createHostFeeShareDebtTransactions({ hostFeeShareTransaction });
  }

  return { hostFeeShareTransaction, hostFeeShareDebtTransaction };
};

Transaction.createHostFeeShareDebtTransactions = async ({
  hostFeeShareTransaction,
}: {
  hostFeeShareTransaction: TransactionInterface;
}): Promise<TransactionInterface> => {
  if (hostFeeShareTransaction.type === DEBIT) {
    throw new Error('createHostFeeShareDebtTransactions must be given a CREDIT transaction');
  }

  // Create debt transaction
  const hostFeeShareDebtTransactionData = {
    // Copy base values from the original CREDIT HOST_FEE_SHARE
    ...pick(hostFeeShareTransaction.dataValues, [
      'TransactionGroup',
      'FromCollectiveId',
      'CollectiveId',
      'HostCollectiveId',
      'OrderId',
      'createdAt',
      'clearedAt',
      'currency',
      'hostCurrency',
      'hostCurrencyFxRate',
    ]),
    type: DEBIT,
    kind: TransactionKind.HOST_FEE_SHARE_DEBT,
    isDebt: true,
    description: 'Host Fee Share owed to Open Collective',
    // Opposite amounts
    amount: -hostFeeShareTransaction.amount,
    netAmountInCollectiveCurrency: -hostFeeShareTransaction.netAmountInCollectiveCurrency,
    amountInHostCurrency: -hostFeeShareTransaction.amountInHostCurrency,
    // No fees
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
  };

  const hostFeeShareDebtTransaction = await Transaction.createDoubleEntry(hostFeeShareDebtTransactionData);

  // Create settlement
  const settlementStatus = TransactionSettlementStatus.OWED;
  await TransactionSettlement.createForTransaction(hostFeeShareDebtTransaction, settlementStatus);

  return hostFeeShareDebtTransaction;
};

/**
 * Creates a transaction pair from given payload. Defaults to `CONTRIBUTION` kind unless
 * specified otherwise.
 */
Transaction.createFromContributionPayload = async (
  transaction: TransactionCreationAttributes,
): Promise<TransactionInterface> => {
  try {
    Transaction.validateContributionPayload(transaction);
  } catch (error) {
    throw new Error(`createFromContributionPayload: ${error.message}`);
  }

  // Retrieve Host
  const collective = await Collective.findByPk(transaction.CollectiveId);
  const host = await collective.getHostCollective();
  transaction.HostCollectiveId = collective.isHostAccount ? collective.id : host.id;
  if (!transaction.HostCollectiveId) {
    throw new Error(`Cannot create transaction: Collective with id '${transaction.CollectiveId}' doesn't have a Host`);
  }

  // Compute these values, they will eventually be checked again by createDoubleEntry
  transaction.TransactionGroup = uuid();
  transaction.type = TransactionTypes.CREDIT;
  transaction.kind = transaction.kind || TransactionKind.CONTRIBUTION;

  // Some test may skip amountInHostCurrency and hostCurrency
  if (!transaction.hostCurrency && !transaction.amountInHostCurrency) {
    transaction.amountInHostCurrency = transaction.amount;
    transaction.hostCurrency = transaction.currency;
  }

  transaction.hostFeeInHostCurrency = toNegative(transaction.hostFeeInHostCurrency) || 0;
  transaction.platformFeeInHostCurrency = toNegative(transaction.platformFeeInHostCurrency) || 0;
  transaction.paymentProcessorFeeInHostCurrency = toNegative(transaction.paymentProcessorFeeInHostCurrency) || 0;
  transaction.taxAmount = toNegative(transaction.taxAmount);

  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return Transaction.createDoubleEntry(transaction);
};

Transaction.fetchHost = async (
  transaction: TransactionInterface | TransactionCreationAttributes,
): Promise<Collective | null> => {
  let host;
  if (transaction.HostCollectiveId) {
    host = await Collective.findByPk(transaction.HostCollectiveId);
  }
  if (!host) {
    // throw new Error(`transaction.HostCollectiveId should always bet set`);
    console.warn(`transaction.HostCollectiveId should always bet set`);
    const collective = await Collective.findByPk(transaction.CollectiveId);
    host = await collective.getHostCollective();
  }
  return host;
};

Transaction.createActivity = async (
  transaction: TransactionInterface,
  options: { sequelizeTransaction?: SequelizeTransaction } = {},
): Promise<Activity | void> => {
  if (transaction.deletedAt || ['TAX', 'PAYMENT_PROCESSOR_FEE'].includes(transaction.kind)) {
    return Promise.resolve();
  }
  return (
    Transaction.findByPk(transaction.id, {
      include: [
        { model: Collective, as: 'fromCollective' },
        { model: Collective, as: 'collective' },
        { model: User, as: 'createdByUser' },
        { model: PaymentMethod },
      ],
      transaction: options?.sequelizeTransaction,
    })
      // Create activity.
      .then(transaction => {
        const activityPayload = {
          type: activities.COLLECTIVE_TRANSACTION_CREATED,
          TransactionId: transaction.id,
          CollectiveId: transaction.CollectiveId,
          UserId: transaction.CreatedByUserId,
          FromCollectiveId: transaction.FromCollectiveId,
          HostCollectiveId: transaction.HostCollectiveId,
          OrderId: transaction.OrderId,
          data: {
            transaction: transaction.info,
            user: transaction['User'] && transaction['User'].minimal, // TODO: `transaction.user` doesn't seem to exists, should be createdByUser?
            fromCollective: transaction.fromCollective && transaction.fromCollective.minimal,
            collective: transaction.collective && transaction.collective.minimal,
          },
        };
        if (transaction.createdByUser) {
          activityPayload.data.user = transaction.createdByUser.info;
        }
        if (transaction.PaymentMethod) {
          activityPayload.data['paymentMethod'] = transaction.PaymentMethod.info;
        }
        return Activity.create(activityPayload, { transaction: options?.sequelizeTransaction });
      })
      .catch(err => {
        console.error(
          `Error creating activity of type ${activities.COLLECTIVE_TRANSACTION_CREATED} for transaction ID ${transaction.id}`,
          err,
        );
        reportErrorToSentry(err);
      })
  );
};

Transaction.canHaveFees = function ({ kind }: { kind: TransactionKind }): boolean {
  return [CONTRIBUTION, EXPENSE, ADDED_FUNDS].includes(kind);
};

Transaction.calculateNetAmountInCollectiveCurrency = function ({
  amountInHostCurrency,
  hostCurrencyFxRate,
  hostFeeInHostCurrency,
  paymentProcessorFeeInHostCurrency,
  platformFeeInHostCurrency,
  taxAmount,
}) {
  const transactionFees = platformFeeInHostCurrency + hostFeeInHostCurrency + paymentProcessorFeeInHostCurrency;
  const transactionTaxes = taxAmount || 0;
  return Math.round((amountInHostCurrency + transactionFees) / (hostCurrencyFxRate || 1) + transactionTaxes);
};

Transaction.calculateNetAmountInHostCurrency = function ({
  amountInHostCurrency,
  hostCurrencyFxRate,
  hostFeeInHostCurrency,
  paymentProcessorFeeInHostCurrency,
  platformFeeInHostCurrency,
  taxAmount,
}) {
  const transactionFees = platformFeeInHostCurrency + hostFeeInHostCurrency + paymentProcessorFeeInHostCurrency;
  const transactionTaxes = taxAmount || 0;
  return amountInHostCurrency + transactionFees + Math.round(transactionTaxes * (hostCurrencyFxRate || 1));
};

Transaction.getFxRate = async function (fromCurrency, toCurrency, transaction) {
  if (fromCurrency === toCurrency) {
    return 1;
  }

  // Simple Case
  if (fromCurrency === transaction.currency && toCurrency === transaction.hostCurrency) {
    return transaction.hostCurrencyFxRate;
  }
  if (fromCurrency === transaction.hostCurrency && toCurrency === transaction.currency) {
    return 1 / transaction.hostCurrencyFxRate;
  }

  // For platform tips, we store the FX rate of the host<>currency
  // TODO: The thingy below is useful for the migration of platform tips with debts, but
  // we should ideally not rely on `data?.hostToPlatformFxRate` for that
  if (transaction.data?.hostToPlatformFxRate) {
    if (
      toCurrency === PLATFORM_TIP_TRANSACTION_PROPERTIES.currency &&
      fromCurrency === transaction.hostCurrency &&
      transaction.type === CREDIT &&
      transaction.kind === TransactionKind.PLATFORM_TIP &&
      transaction.FromCollectiveId === PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId
    ) {
      return transaction.data.hostToPlatformFxRate;
    }
  }

  // If Stripe transaction, we check if we have the rate stored locally
  if (transaction.data?.balanceTransaction?.['exchange_rate']) {
    if (
      transaction.data.charge?.['currency'] === fromCurrency.toLowerCase() &&
      transaction.data.balanceTransaction['currency'] === toCurrency.toLowerCase()
    ) {
      return transaction.data.balanceTransaction['exchange_rate'];
    }
    if (
      transaction.data?.charge?.['currency'] === toCurrency.toLowerCase() &&
      transaction.data?.balanceTransaction?.['currency'] === fromCurrency.toLowerCase()
    ) {
      return 1 / transaction.data.balanceTransaction['exchange_rate'];
    }
  }

  // If Transferwise transaction, we check if we have the rate stored locally
  if (transaction.data?.transfer?.['rate']) {
    if (
      transaction.data?.transfer?.['sourceCurrency'] === fromCurrency &&
      transaction.data?.transfer?.['targetCurrency'] === toCurrency
    ) {
      return transaction.data.transfer['rate'];
    }
    if (
      transaction.data?.transfer?.['sourceCurrency'] === toCurrency &&
      transaction.data?.transfer?.['targetCurrency'] === fromCurrency
    ) {
      return 1 / transaction.data.transfer['rate'];
    }
  }

  return getFxRate(fromCurrency, toCurrency, transaction.createdAt || 'latest');
};

Transaction.updateCurrency = async function (
  currency: SupportedCurrency,
  transaction: TransactionInterface,
): Promise<TransactionInterface> {
  // Nothing to do
  if (currency === transaction.currency) {
    return transaction;
  }

  // Immediately convert taxAmount if necessary
  // We don't store it in hostCurrency and can't populate like other values
  if (transaction.taxAmount) {
    const previousCurrency = transaction.currency;
    const fxRate = await Transaction.getFxRate(previousCurrency, currency, transaction);
    transaction.taxAmount = Math.round(transaction.taxAmount * fxRate);
  }

  transaction.currency = currency;
  transaction.hostCurrencyFxRate = await Transaction.getFxRate(
    transaction.currency,
    transaction.hostCurrency,
    transaction,
  );

  // REMINDER: amount * hostCurrencyFxRate = amountInHostCurrency
  // so: amount = amountInHostCurrency / hostCurrencyFxRate
  transaction.amount = Math.round(transaction.amountInHostCurrency / transaction.hostCurrencyFxRate);
  transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

  return transaction;
};

/**
 * To validate that the different amounts are correct.
 *
 * @param {Transaction} transaction
 * @param {Object} options
 * @param {Boolean} options.validateOppositeTransaction
 * @param {Transaction} options.oppositeTransaction the opposite transaction to validate. Will be fetched if not provided and validateOppositeTransaction is true.
 * @returns
 */
Transaction.validate = async (
  transaction: TransactionInterface,
  { validateOppositeTransaction = true, oppositeTransaction = null } = {},
) => {
  // Skip as there is a known bug there
  // https://github.com/opencollective/opencollective/issues/3935
  if (transaction.kind === TransactionKind.PLATFORM_TIP) {
    return;
  }

  for (const key of [
    'uuid',
    'TransactionGroup',
    'amount',
    'currency',
    'amountInHostCurrency',
    'hostCurrency',
    'hostCurrencyFxRate',
    'netAmountInCollectiveCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'paymentProcessorFeeInHostCurrency',
  ]) {
    assert(!isNil(transaction[key]), `${key} should be set`);
  }

  const hostCurrencyFxRate = transaction.hostCurrencyFxRate || 1;

  Transaction.assertAmountsLooselyEqual(
    Math.round(transaction.amountInHostCurrency / hostCurrencyFxRate),
    transaction.amount,
    'amountInHostCurrency should match amount',
  );

  const netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);
  Transaction.assertAmountsLooselyEqual(
    transaction.netAmountInCollectiveCurrency,
    netAmountInCollectiveCurrency,
    'netAmountInCollectiveCurrency should be accurate',
  );

  if (transaction.currency === transaction.hostCurrency) {
    assert(transaction.hostCurrencyFxRate === 1, 'hostCurrencyFxRate should be 1');
  } else {
    assert(transaction.hostCurrencyFxRate !== 1, 'hostCurrencyFxRate should not be 1');
  }

  if (!validateOppositeTransaction) {
    return;
  }

  // Stop there in this case, no need to check oppositeTransaction as it doesn't exist
  if (transaction.CollectiveId === transaction.FromCollectiveId) {
    return;
  }

  oppositeTransaction = oppositeTransaction || (await transaction.getOppositeTransaction());
  assert(oppositeTransaction, 'oppositeTransaction should be existing');

  // Ideally, but we should not enforce it at this point
  /*
    assert(transaction.currency === oppositeTransaction.currency, 'oppositeTransaction currency should match');
    Transaction.assertAmountsStrictlyEqual(
      oppositeTransaction.netAmountInCollectiveCurrency,
      -1 * transaction.amount,
      'netAmountInCollectiveCurrency in oppositeTransaction should match',
    );
    Transaction.assertAmountsStrictlyEqual(
      oppositeTransaction.amount,
      -1 * transaction.netAmountInCollectiveCurrency,
      'amount in oppositeTransaction should match',
    );
    */

  const oppositeTransactionHostCurrencyFxRate =
    // Use the one stored locally in oppositeTransaction
    <number>oppositeTransaction.data?.oppositeTransactionHostCurrencyFxRate ||
    <number>oppositeTransaction.data?.oppositeTransactionFeesCurrencyFxRate ||
    // Use the one stored locally in transaction
    (transaction.data?.oppositeTransactionHostCurrencyFxRate
      ? 1 / <number>transaction.data?.oppositeTransactionHostCurrencyFxRate
      : null) ||
    (transaction.data?.oppositeTransactionFeesCurrencyFxRate
      ? 1 / <number>transaction.data?.oppositeTransactionFeesCurrencyFxRate
      : null) ||
    // Fetch from getFxRate
    (await Transaction.getFxRate(transaction.hostCurrency, oppositeTransaction.hostCurrency, transaction));

  Transaction.assertAmountsStrictlyEqual(
    oppositeTransaction.platformFeeInHostCurrency || 0,
    Math.round((transaction.platformFeeInHostCurrency || 0) * oppositeTransactionHostCurrencyFxRate),
    'platformFeeInHostCurrency in oppositeTransaction should match',
  );

  Transaction.assertAmountsStrictlyEqual(
    oppositeTransaction.hostFeeInHostCurrency || 0,
    Math.round((transaction.hostFeeInHostCurrency || 0) * oppositeTransactionHostCurrencyFxRate),
    'hostFeeInHostCurrency in oppositeTransaction should match',
  );

  Transaction.assertAmountsStrictlyEqual(
    oppositeTransaction.paymentProcessorFeeInHostCurrency || 0,
    Math.round((transaction.paymentProcessorFeeInHostCurrency || 0) * oppositeTransactionHostCurrencyFxRate),
    'paymentProcessorFeeInHostCurrency in oppositeTransaction should match',
  );

  /*
    Transaction.assertAmountsStrictlyEqual(
      oppositeTransaction.amountInHostCurrency,
      Math.round(transaction.netAmountInCollectiveCurrency * oppositeTransactionHostCurrencyFxRate),
      'amountInHostCurrency in oppositeTransaction should match',
    );

    Transaction.assertAmountsLooselyEqual(
      oppositeTransaction.amount,
      -Math.round(transaction.netAmountInCollectiveCurrency * oppositeTransactionCurrencyFxRate),
      'amount in oppositeTransaction should match',
    );
    */
};

Transaction.assertAmountsStrictlyEqual = (actual, expected, message) => {
  assert.equal(actual, expected, `${message}: ${actual} doesn't strictly equal to ${expected}`);
};

Transaction.assertAmountsLooselyEqual = (actual, expected, message) => {
  assert(Math.abs(actual - expected) <= 100, `${message}: ${actual} doesn't loosely equal to ${expected}`);
};

export default Transaction;
