import assert from 'assert';

import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { defaultsDeep, get, isNil, isNull, isUndefined, omit, pick } from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import activities from '../constants/activities';
import { TransactionKind } from '../constants/transaction-kind';
import { PLATFORM_TIP_TRANSACTION_PROPERTIES, TransactionTypes } from '../constants/transactions';
import { getFxRate } from '../lib/currency';
import { toNegative } from '../lib/math';
import { calcFee } from '../lib/payments';
import { stripHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import { exportToCSV, parseToBoolean } from '../lib/utils';

import CustomDataTypes from './DataTypes';
import { TransactionSettlementStatus } from './TransactionSettlement';

const debug = debugLib('models:Transaction');

function defineModel() {
  const { models } = sequelize;

  const Transaction = sequelize.define(
    'Transaction',
    {
      type: DataTypes.STRING, // DEBIT or CREDIT

      kind: {
        allowNull: true,
        type: DataTypes.ENUM(Object.values(TransactionKind)),
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
        description: 'References the collective that created the gift card used for this order',
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
        set(val) {
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

      isRefund: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },

      isDebt: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
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

      /** A virtual field to make working with settlements easier. Must be preloaded manually. */
      settlementStatus: {
        type: DataTypes.VIRTUAL,
      },
    },
    {
      paranoid: true,

      getterMethods: {
        netAmountInHostCurrency() {
          return (
            this.amountInHostCurrency +
            this.paymentProcessorFeeInHostCurrency +
            this.platformFeeInHostCurrency +
            this.hostFeeInHostCurrency
          );
        },

        amountSentToHostInHostCurrency() {
          return this.amountInHostCurrency + this.paymentProcessorFeeInHostCurrency + this.platformFeeInHostCurrency;
        },

        // Info.
        info() {
          return {
            id: this.id,
            uuid: this.uuid,
            type: this.type,
            kind: this.kind,
            description: this.description,
            amount: this.amount,
            currency: this.currency,
            createdAt: this.createdAt,
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
            hostCurrency: this.hostCurrency,
            ExpenseId: this.ExpenseId,
            OrderId: this.OrderId,
            isRefund: this.isRefund,
            isDebt: this.isDebt,
          };
        },
      },

      hooks: {
        afterCreate: transaction => {
          Transaction.createActivity(transaction);
          // intentionally returns null, needs to be async (https://github.com/petkaantonov/bluebird/blob/master/docs/docs/warning-explanations.md#warning-a-promise-was-created-in-a-handler-but-was-not-returned-from-it)
          return null;
        },
      },
    },
  );

  /**
   * Instance Methods
   */
  Transaction.prototype.getUser = function () {
    return models.User.findByPk(this.CreatedByUserId);
  };

  Transaction.prototype.getGiftCardEmitterCollective = function () {
    if (this.UsingGiftCardFromCollectiveId) {
      return models.Collective.findByPk(this.UsingGiftCardFromCollectiveId);
    }
  };

  Transaction.prototype.getHostCollective = async function () {
    let HostCollectiveId = this.HostCollectiveId;
    // if the transaction is from the perspective of the fromCollective
    if (!HostCollectiveId) {
      const fromCollective = await models.Collective.findByPk(this.FromCollectiveId);
      HostCollectiveId = await fromCollective.getHostCollectiveId();
    }
    return models.Collective.findByPk(HostCollectiveId);
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

  Transaction.prototype.getDetailsForUser = function (user) {
    const sourceCollective = this.paymentMethodProviderCollectiveId();
    return user.populateRoles().then(() => {
      if (
        user.isAdmin(this.CollectiveId) ||
        user.isAdmin(this.FromCollectiveId) ||
        user.isAdmin(sourceCollective) ||
        user.isRoot()
      ) {
        return this.uuid;
      } else {
        return null;
      }
    });
  };

  Transaction.prototype.getRefundTransaction = function () {
    if (!this.RefundTransactionId) {
      return null;
    }
    return Transaction.findByPk(this.RefundTransactionId);
  };

  Transaction.prototype.hasPlatformTip = function () {
    return Boolean(this.data?.isFeesOnTop && this.kind !== TransactionKind.PLATFORM_TIP);
  };

  Transaction.prototype.getPlatformTipTransaction = function () {
    if (this.hasPlatformTip()) {
      return models.Transaction.findOne({
        where: {
          ...pick(PLATFORM_TIP_TRANSACTION_PROPERTIES, ['CollectiveId']),
          type: this.type,
          TransactionGroup: this.TransactionGroup,
          kind: TransactionKind.PLATFORM_TIP,
          isDebt: { [Op.not]: true },
        },
      });
    }
  };

  Transaction.prototype.getHostFeeTransaction = function () {
    return models.Transaction.findOne({
      where: {
        type: this.type,
        TransactionGroup: this.TransactionGroup,
        kind: TransactionKind.HOST_FEE,
        isDebt: { [Op.not]: true },
      },
    });
  };

  Transaction.prototype.getOppositeTransaction = async function () {
    return models.Transaction.findOne({
      where: {
        type: this.type === 'CREDIT' ? 'DEBIT' : 'CREDIT',
        CollectiveId: this.FromCollectiveId,
        FromCollectiveId: this.CollectiveId,
        TransactionGroup: this.TransactionGroup,
        kind: this.kind,
        isDebt: this.isDebt,
      },
    });
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
  Transaction.createMany = (transactions, defaultValues) => {
    return Promise.map(transactions, transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.create(transaction);
    }).catch(console.error);
  };

  Transaction.createManyDoubleEntry = (transactions, defaultValues) => {
    return Promise.map(transactions, transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.createDoubleEntry(transaction);
    }).catch(console.error);
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

    // We only add tax amount for european hosts
    if (transactions[0].hostCurrency === 'EUR') {
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

  Transaction.createDoubleEntry = async (transaction, opts) => {
    transaction.type = transaction.amount > 0 ? TransactionTypes.CREDIT : TransactionTypes.DEBIT;
    transaction.netAmountInCollectiveCurrency = transaction.netAmountInCollectiveCurrency || transaction.amount;
    transaction.TransactionGroup = transaction.TransactionGroup || uuid();
    transaction.hostCurrencyFxRate = transaction.hostCurrencyFxRate || 1;

    if (!isUndefined(transaction.amountInHostCurrency)) {
      // ensure this is always INT
      transaction.amountInHostCurrency = Math.round(transaction.amountInHostCurrency);
    }

    const fromCollective = await models.Collective.findByPk(transaction.FromCollectiveId);
    const fromCollectiveHost = await fromCollective.getHostCollective();

    let oppositeTransaction = {
      ...transaction,
      type: -transaction.amount > 0 ? TransactionTypes.CREDIT : TransactionTypes.DEBIT,
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
    }

    debug('createDoubleEntry', transaction, 'opposite', oppositeTransaction);

    // We first record the negative transaction
    // and only then we can create the transaction to add money somewhere else
    const transactions = [];
    let index = 0;
    if (transaction.amount < 0) {
      index = 0;
      transactions.push(transaction);
      // Skip CREDIT when inserting a DEBIT to itself
      if (transaction.CollectiveId !== transaction.FromCollectiveId) {
        transactions.push(oppositeTransaction);
      }
    } else {
      index = 1;
      transactions.push(oppositeTransaction);
      transactions.push(transaction);
    }

    return Promise.mapSeries(transactions, t => Transaction.create(t, opts)).then(results => results[index]);
  };

  /**
   * Record a debt transaction and its associated settlement
   */
  Transaction.createPlatformTipDebtTransactions = async (tipCreditTransactionData, host) => {
    if (tipCreditTransactionData.type === 'DEBIT') {
      throw new Error('createPlatformTipDebtTransactions must be given a CREDIT');
    }

    const hostToPlatformFxRate = tipCreditTransactionData.data?.hostToPlatformFxRate || 1;
    const amountInHostCurrency = Math.round(
      tipCreditTransactionData.netAmountInCollectiveCurrency / hostToPlatformFxRate,
    );

    // Create debt transaction
    const debtTransactionData = {
      ...omit(tipCreditTransactionData, ['id', 'uuid', 'PaymentMethodId', 'data']), // TODO: We may want to remove the OrderId here
      type: 'CREDIT',
      description: 'Platform Tip collected for Open Collective',
      amountInHostCurrency,
      amount: amountInHostCurrency,
      netAmountInCollectiveCurrency: amountInHostCurrency,
      currency: host.currency,
      hostCurrency: host.currency,
      data: { hostToPlatformFxRate },
      CollectiveId: host.id,
      FromCollectiveId: PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId,
      HostCollectiveId: host.id,
      kind: TransactionKind.PLATFORM_TIP,
      isDebt: true,
    };

    const debtTransaction = await Transaction.createDoubleEntry(debtTransactionData);

    // Create settlement
    const settlementStatus = TransactionSettlementStatus.OWED;
    await models.TransactionSettlement.createForTransaction(debtTransaction, settlementStatus);

    return debtTransaction;
  };

  /**
   * Creates platform tip transactions from a given transaction.
   * @param {Transaction} The actual transaction
   * @param {models.Collective} The host
   * @param {boolean} Whether tip has been collected already (no debt needed)
   */
  Transaction.createPlatformTipTransactions = async (transaction, host, isDirectlyCollected = false) => {
    if (!transaction.data?.isFeesOnTop || !transaction.platformFeeInHostCurrency) {
      return;
    }

    // Calculate the paymentProcessorFee proportional to the feeOnTop amount
    const feeOnTopPercent = Math.abs(transaction.platformFeeInHostCurrency / transaction.amountInHostCurrency);
    const feeOnTopPaymentProcessorFee = host?.data?.reimbursePaymentProcessorFeeOnTips
      ? toNegative(Math.round(transaction.paymentProcessorFeeInHostCurrency * feeOnTopPercent))
      : 0;
    const platformCurrencyFxRate = await getFxRate(transaction.currency, PLATFORM_TIP_TRANSACTION_PROPERTIES.currency);
    const platformTipTransactionData = defaultsDeep(
      {},
      PLATFORM_TIP_TRANSACTION_PROPERTIES,
      {
        description: 'Financial contribution to Open Collective',
        amount: Math.round(Math.abs(transaction.platformFeeInHostCurrency) * platformCurrencyFxRate),
        amountInHostCurrency: Math.round(Math.abs(transaction.platformFeeInHostCurrency) * platformCurrencyFxRate),
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        kind: TransactionKind.PLATFORM_TIP,
        // Represent the paymentProcessorFee in USD
        paymentProcessorFeeInHostCurrency: Math.round(feeOnTopPaymentProcessorFee * platformCurrencyFxRate),
        // Calculate the netAmount by deducting the proportional paymentProcessorFee
        netAmountInCollectiveCurrency: Math.round(
          (Math.abs(transaction.platformFeeInHostCurrency) + feeOnTopPaymentProcessorFee) * platformCurrencyFxRate,
        ),
        // This is always 1 because OpenCollective and OpenCollective Inc (Host) are in USD.
        hostCurrencyFxRate: 1,
        TransactionGroup: transaction.TransactionGroup,
        isDebt: false,
        data: {
          hostToPlatformFxRate: await getFxRate(transaction.hostCurrency, PLATFORM_TIP_TRANSACTION_PROPERTIES.currency),
          feeOnTopPaymentProcessorFee,
          settled: transaction.data?.settled,
        },
      },
      transaction,
    );

    const platformTipTransaction = await Transaction.createDoubleEntry(platformTipTransactionData);
    let platformTipDebtTransaction;
    if (!isDirectlyCollected) {
      platformTipDebtTransaction = await Transaction.createPlatformTipDebtTransactions(
        platformTipTransactionData,
        host,
      );
    }

    // Deduct the paymentProcessorFee we considered part of the feeOnTop donation
    transaction.paymentProcessorFeeInHostCurrency =
      transaction.paymentProcessorFeeInHostCurrency - feeOnTopPaymentProcessorFee;
    // Recalculate amount
    transaction.amountInHostCurrency = transaction.amountInHostCurrency + transaction.platformFeeInHostCurrency;
    transaction.amount = Math.round(
      transaction.amount + transaction.platformFeeInHostCurrency / (transaction.hostCurrencyFxRate || 1),
    );
    // Reset the platformFee because we're accounting for this value in a separate set of transactions
    transaction.platformFeeInHostCurrency = 0;

    return { transaction, platformTipTransaction, platformTipDebtTransaction };
  };

  Transaction.validateContributionPayload = payload => {
    if (!payload.amount || payload.amount < 0) {
      throw new Error('amount should be set and positive');
    }
    if (!payload.currency) {
      throw new Error('currency should be set');
    }
    if (payload.hostCurrency && (!payload.amountInHostCurrency || payload.amountInHostCurrency < 0)) {
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

  Transaction.createHostFeeTransactions = async (transaction, host, data) => {
    if (!transaction.hostFeeInHostCurrency) {
      return;
    }

    const amountInHostCurrency = Math.abs(transaction.hostFeeInHostCurrency);
    const amountInCollectiveCurrency = Math.round(amountInHostCurrency / transaction.hostCurrencyFxRate);
    const hostFeeTransaction = {
      type: TransactionTypes.CREDIT,
      kind: TransactionKind.HOST_FEE,
      description: 'Host Fee',
      TransactionGroup: transaction.TransactionGroup,
      FromCollectiveId: transaction.CollectiveId,
      CollectiveId: host.id,
      HostCollectiveId: host.id,
      // Compute amounts
      amount: amountInCollectiveCurrency,
      netAmountInCollectiveCurrency: amountInCollectiveCurrency,
      currency: transaction.currency,
      amountInHostCurrency: amountInHostCurrency,
      hostCurrency: transaction.hostCurrency,
      hostCurrencyFxRate: transaction.hostCurrencyFxRate,
      // No fees
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: 0,
      OrderId: transaction.OrderId,
      createdAt: transaction.createdAt,
      data,
    };

    await Transaction.createDoubleEntry(hostFeeTransaction);

    // Reset the original host fee because we're now accounting for this value in a separate set of transactions
    transaction.hostFeeInHostCurrency = 0;

    return { transaction, hostFeeTransaction };
  };

  /**
   * Creates a transaction pair from given payload. Defaults to `CONTRIBUTION` kind unless
   * specified otherwise.
   */
  Transaction.createFromContributionPayload = async (transaction, opts = { isPlatformTipDirectlyCollected: false }) => {
    try {
      Transaction.validateContributionPayload(transaction);
    } catch (error) {
      throw new Error(`createFromContributionPayload: ${error.message}`);
    }

    // Retrieve Host
    const collective = await models.Collective.findByPk(transaction.CollectiveId);
    const host = await collective.getHostCollective();
    transaction.HostCollectiveId = collective.isHostAccount ? collective.id : host.id;
    if (!transaction.HostCollectiveId) {
      throw new Error(
        `Cannot create transaction: Collective with id '${transaction.CollectiveId}' doesn't have a Host`,
      );
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

    // Separate donation transaction and remove platformFee from the main transaction
    if (transaction.data?.isFeesOnTop && transaction.platformFeeInHostCurrency) {
      const isTipAlreadyCollected = Boolean(opts?.isPlatformTipDirectlyCollected);
      const result = await Transaction.createPlatformTipTransactions(transaction, host, isTipAlreadyCollected);
      // Transaction was modified by createPlatformTipTransactions, we get it from the result
      if (result && result.transaction) {
        transaction = result.transaction;
      }
    }

    // Create Host Fee transaction
    if (transaction.hostFeeInHostCurrency && parseToBoolean(config.ledger.separateHostFees) === true) {
      // transaction.hostFeeInHostCurrency = 0;
      const result = await Transaction.createHostFeeTransactions(transaction, host);
      // Transaction was modified by createHostFeeTransaction, we get it from the result
      if (result && result.transaction) {
        transaction = result.transaction;
      }
    }

    transaction.netAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency(transaction);

    return Transaction.createDoubleEntry(transaction);
  };

  Transaction.createActivity = (transaction, options) => {
    if (transaction.deletedAt) {
      return Promise.resolve();
    }
    return (
      Transaction.findByPk(transaction.id, {
        include: [
          { model: models.Collective, as: 'fromCollective' },
          { model: models.Collective, as: 'collective' },
          { model: models.User, as: 'createdByUser' },
          { model: models.PaymentMethod },
        ],
        transaction: options?.transaction,
      })
        // Create activity.
        .then(transaction => {
          const activityPayload = {
            type: activities.COLLECTIVE_TRANSACTION_CREATED,
            TransactionId: transaction.id,
            CollectiveId: transaction.CollectiveId,
            CreatedByUserId: transaction.CreatedByUserId,
            data: {
              transaction: transaction.info,
              user: transaction.User && transaction.User.minimal,
              fromCollective: transaction.fromCollective && transaction.fromCollective.minimal,
              collective: transaction.collective && transaction.collective.minimal,
            },
          };
          if (transaction.createdByUser) {
            activityPayload.data.user = transaction.createdByUser.info;
          }
          if (transaction.PaymentMethod) {
            activityPayload.data.paymentMethod = transaction.PaymentMethod.info;
          }
          return models.Activity.create(activityPayload, { transaction: options?.transaction });
        })
        .catch(err =>
          console.error(
            `Error creating activity of type ${activities.COLLECTIVE_TRANSACTION_CREATED} for transaction ID ${transaction.id}`,
            err,
          ),
        )
    );
  };

  Transaction.creditHost = (order, collective) => {
    // Special Case, adding funds to itself
    const amount = order.totalAmount;
    const platformFeePercent = get(order, 'data.platformFeePercent', 0);
    const platformFee = calcFee(order.totalAmount, platformFeePercent);
    const payload = {
      type: 'CREDIT',
      kind: TransactionKind.ADDED_FUNDS,
      amount,
      description: order.description,
      currency: order.currency,
      CollectiveId: order.CollectiveId,
      FromCollectiveId: order.CollectiveId,
      CreatedByUserId: order.CreatedByUserId,
      PaymentMethodId: order.PaymentMethodId,
      OrderId: order.id,
      platformFeeInHostCurrency: -platformFee,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: 0,
      HostCollectiveId: collective.id,
      hostCurrency: collective.currency,
      hostCurrencyFxRate: 1,
      amountInHostCurrency: amount,
      netAmountInCollectiveCurrency: amount - platformFee,
      TransactionGroup: uuid(),
    };

    return models.Transaction.create(payload);
  };

  Transaction.calculateNetAmountInCollectiveCurrency = function (transaction) {
    const transactionFees =
      transaction.platformFeeInHostCurrency +
      transaction.hostFeeInHostCurrency +
      transaction.paymentProcessorFeeInHostCurrency;

    const transactionTaxes = transaction.taxAmount || 0;

    const hostCurrencyFxRate = transaction.hostCurrencyFxRate || 1;

    return Math.round((transaction.amountInHostCurrency + transactionFees) / hostCurrencyFxRate + transactionTaxes);
  };

  Transaction.getFxRate = async function (fromCurrency, toCurrency, transaction) {
    if (fromCurrency === toCurrency) {
      return 1;
    }

    // For platform tips, we store the FX rate of the host<>currency
    // TODO: The thingy below is useful for the migration of platform tips with debts, but
    // we should ideally not rely on `data?.hostToPlatformFxRate` for that
    if (transaction.data?.hostToPlatformFxRate) {
      if (
        toCurrency === PLATFORM_TIP_TRANSACTION_PROPERTIES.currency &&
        fromCurrency === transaction.hostCurrency &&
        transaction.type === 'CREDIT' &&
        transaction.kind === 'PLATFORM_TIP' &&
        transaction.FromCollectiveId === PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId
      ) {
        return transaction.data.hostToPlatformFxRate;
      }
    }

    // If Stripe transaction, we check if we have the rate stored locally
    // eslint-disable-next-line camelcase
    if (transaction.data?.balanceTransaction?.exchange_rate) {
      if (
        transaction.data?.charge?.currency === fromCurrency.toLowerCase() &&
        transaction.data?.balanceTransaction?.currency === toCurrency.toLowerCase()
      ) {
        return transaction.data.balanceTransaction.exchange_rate; // eslint-disable-line camelcase
      }
      if (
        transaction.data?.charge?.currency === toCurrency.toLowerCase() &&
        transaction.data?.balanceTransaction?.currency === fromCurrency.toLowerCase()
      ) {
        return 1 / transaction.data.balanceTransaction.exchange_rate; // eslint-disable-line camelcase
      }
    }

    // If Transferwise transaction, we check if we have the rate stored locally
    if (transaction.data?.transfer?.rate) {
      if (
        transaction.data?.transfer?.sourceCurrency === fromCurrency &&
        transaction.data?.transfer?.targetCurrency === toCurrency
      ) {
        return transaction.data.transfer.rate;
      }
      if (
        transaction.data?.transfer?.sourceCurrency === toCurrency &&
        transaction.data?.transfer?.targetCurrency === fromCurrency
      ) {
        return 1 / transaction.data.transfer.rate;
      }
    }

    return getFxRate(fromCurrency, toCurrency, transaction.createdAt);
  };

  Transaction.updateCurrency = async function (currency, transaction) {
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

  Transaction.validate = async (transaction, { validateOppositeTransaction = true } = {}) => {
    // Skip as there is a known bug there
    // https://github.com/opencollective/opencollective/issues/3935
    if (transaction.kind === TransactionKind.PLATFORM_TIP) {
      return;
    }

    // Skip as there is a known bug there
    // https://github.com/opencollective/opencollective/issues/3934
    if (transaction.kind === TransactionKind.PLATFORM_TIP && transaction.taxAmount) {
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

    const oppositeTransaction = await transaction.getOppositeTransaction();
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
      oppositeTransaction.data?.oppositeTransactionHostCurrencyFxRate ||
      oppositeTransaction.data?.oppositeTransactionFeesCurrencyFxRate ||
      // Use the one stored locally in transaction
      (transaction.data?.oppositeTransactionHostCurrencyFxRate
        ? 1 / transaction.data?.oppositeTransactionHostCurrencyFxRate
        : null) ||
      (transaction.data?.oppositeTransactionFeesCurrencyFxRate
        ? 1 / transaction.data?.oppositeTransactionFeesCurrencyFxRate
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

  return Transaction;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Transaction = defineModel();

export default Transaction;
