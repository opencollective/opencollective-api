import { TaxType } from '@opencollective/taxes';
import { get, isEmpty, pick, sumBy } from 'lodash';
import { isMoment } from 'moment';
import {
  BelongsToGetAssociationMixin,
  BelongsToSetAssociationMixin,
  CreationOptional,
  ForeignKey,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';
import Temporal from 'sequelize-temporal';
import Stripe from 'stripe';
import validator from 'validator';

import ActivityTypes from '../constants/activities';
import { SupportedCurrency } from '../constants/currencies';
import ExpenseStatus from '../constants/expense-status';
import ExpenseType from '../constants/expense-type';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import { reduceArrayToCurrency } from '../lib/currency';
import logger from '../lib/logger';
import SQLQueries from '../lib/queries';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../lib/sanitize-html';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Model, Op, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import CustomDataTypes from '../models/DataTypes';
import { Location } from '../types/Location';
import {
  BatchGroup,
  ExpenseDataQuoteV2,
  ExpenseDataQuoteV3,
  QuoteV2PaymentOption,
  QuoteV3PaymentOption,
  RecipientAccount,
  Transfer,
} from '../types/transferwise';

import AccountingCategory from './AccountingCategory';
import Activity from './Activity';
import Collective from './Collective';
import ExpenseAttachedFile from './ExpenseAttachedFile';
import ExpenseItem from './ExpenseItem';
import LegalDocument, { LEGAL_DOCUMENT_TYPE } from './LegalDocument';
import PaymentMethod from './PaymentMethod';
import PayoutMethod, { PayoutMethodTypes } from './PayoutMethod';
import RecurringExpense from './RecurringExpense';
import Transaction from './Transaction';
import TransactionSettlement from './TransactionSettlement';
import User from './User';
import VirtualCard from './VirtualCard';
import models, { UploadedFile } from '.';

export { ExpenseStatus, ExpenseType };

export type ExpenseDataValuesRoleDetails = {
  accountingCategory?: AccountingCategory['publicInfo'];
};

export type ExpenseDataValuesByRole = {
  hostAdmin?: ExpenseDataValuesRoleDetails;
  collectiveAdmin?: ExpenseDataValuesRoleDetails;
  submitter?: ExpenseDataValuesRoleDetails;
  prediction?: ExpenseDataValuesRoleDetails;
};

export type ExpenseTaxDefinition = {
  id?: TaxType | `${TaxType}`; // deprecated
  type: TaxType | `${TaxType}`;
  rate: number;
  percentage?: number; // deprecated, https://github.com/opencollective/opencollective/issues/5389
  idNumber?: string;
};

export enum ExpenseLockableFields {
  AMOUNT = 'AMOUNT',
  PAYEE = 'PAYEE',
  DESCRIPTION = 'DESCRIPTION',
  TYPE = 'TYPE',
}

class Expense extends Model<InferAttributes<Expense>, InferCreationAttributes<Expense>> {
  declare public readonly id: CreationOptional<number>;
  declare public UserId: ForeignKey<User['id']>;
  declare public lastEditedById: ForeignKey<User['id']>;
  declare public HostCollectiveId: number;
  declare public FromCollectiveId: number;
  declare public CollectiveId: number;
  declare public PayoutMethodId: ForeignKey<PayoutMethod['id']>;
  declare public PaymentMethodId: number;
  declare public VirtualCardId: ForeignKey<VirtualCard['id']>;
  declare public RecurringExpenseId: ForeignKey<RecurringExpense['id']>;
  declare public AccountingCategoryId: ForeignKey<AccountingCategory['id']>;
  declare public InvoiceFileId: UploadedFile['id'];

  declare public payeeLocation: Location;
  declare public data: Record<string, unknown> & {
    batchGroup?: BatchGroup;
    quote?: ExpenseDataQuoteV2 | ExpenseDataQuoteV3;
    paymentOption?: QuoteV2PaymentOption | QuoteV3PaymentOption;
    transfer?: Transfer;
    valuesByRole?: ExpenseDataValuesByRole;
    recipient?: RecipientAccount;
    /** From PayPal Payouts */
    time_processed?: string;
    payee?: {
      id?: number;
      slug?: string;
      name?: string;
      email?: string;
    };
    draftKey?: string;
    taxes?: ExpenseTaxDefinition[];
    lockedFields?: ExpenseLockableFields[];
    payout_item?: {
      note?: string;
      receiver?: string;
      purpose?: string;
    };
    paymentIntent?: Stripe.PaymentIntent;
    previousPaymentIntents?: Stripe.PaymentIntent[];
  };

  declare public currency: SupportedCurrency;
  declare public amount: number;
  declare public description: string;
  declare public longDescription: CreationOptional<string>;
  declare public privateMessage: CreationOptional<string>;
  declare public invoiceInfo: CreationOptional<string>;
  declare public legacyPayoutMethod: 'paypal' | 'manual' | 'donation' | 'other';

  declare public status: keyof typeof ExpenseStatus;
  declare public onHold: boolean;
  declare public type: ExpenseType;
  declare public feesPayer: 'COLLECTIVE' | 'PAYEE';
  declare public tags: string[];

  declare public incurredAt: CreationOptional<Date>;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public activities?: Activity[];
  declare public Transactions?: Transaction[];
  declare public collective?: Collective;
  declare public fromCollective?: Collective;
  declare public host?: Collective;
  declare public User?: User;
  declare public PayoutMethod?: PayoutMethod;
  declare public PaymentMethod?: PaymentMethod;
  declare public virtualCard?: VirtualCard;
  declare public items?: ExpenseItem[];
  declare public attachedFiles?: ExpenseAttachedFile[];
  declare public invoiceFile?: NonAttribute<UploadedFile>;
  declare public accountingCategory?: AccountingCategory;
  declare public reference: string;

  // Association getters
  declare getActivities: HasManyGetAssociationsMixin<Activity>;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;
  declare getItems: HasManyGetAssociationsMixin<ExpenseItem>;
  declare getPayoutMethod: BelongsToGetAssociationMixin<PayoutMethod>;
  declare getPaymentMethod: BelongsToGetAssociationMixin<PaymentMethod>;
  declare getRecurringExpense: BelongsToGetAssociationMixin<RecurringExpense>;
  declare getTransactions: HasManyGetAssociationsMixin<Transaction>;
  declare getVirtualCard: BelongsToGetAssociationMixin<VirtualCard>;
  declare getAccountingCategory: BelongsToGetAssociationMixin<AccountingCategory>;

  // Association setters
  declare setPaymentMethod: BelongsToSetAssociationMixin<PaymentMethod, number>;

  /**
   * Instance Methods
   */

  /**
   * Create an activity to describe an expense update.
   * @param {string} type: type of the activity, see `constants/activities.js`
   * @param {object} user: the user who triggered the activity. Leave blank for system activities.
   */
  createActivity = async function (
    type: ActivityTypes,
    user: User | { id: number } | null = null,
    data:
      | ({ notifyCollective?: boolean; ledgerTransaction?: Transaction; notify?: boolean } & Record<string, unknown>)
      | null = {},
  ) {
    const submittedByUser = await this.getSubmitterUser();
    const submittedByUserCollective = await Collective.findByPk(submittedByUser.CollectiveId);
    const fromCollective = this.fromCollective || (await Collective.findByPk(this.FromCollectiveId));
    if (!this.collective) {
      this.collective = await this.getCollective();
    }
    const host = await this.collective.getHostCollective(); // may be null
    const payoutMethod = await this.getPayoutMethod();
    const items = this.items || this.data?.items || (await this.getItems());

    let transaction;
    if (data?.ledgerTransaction) {
      transaction = data.ledgerTransaction;
    } else if (this.status === ExpenseStatus.PAID) {
      transaction = await Transaction.findOne({
        where: { type: 'DEBIT', kind: 'EXPENSE', ExpenseId: this.id },
        order: [['id', 'DESC']],
      });
    }

    return Activity.create({
      type,
      UserId: user?.id,
      CollectiveId: this.collective.id,
      FromCollectiveId: this.FromCollectiveId,
      HostCollectiveId: host?.id,
      ExpenseId: this.id,
      TransactionId: transaction?.id,
      data: {
        ...pick(this.data, 'payee'),
        ...pick(data, [
          'isManualPayout',
          'error',
          'payee',
          'draftKey',
          'inviteUrl',
          'recipientNote',
          'message',
          'event',
          'isSystem',
          'notify',
          'notifyCollective',
          'reference',
          'estimatedDelivery',
        ]),
        host: get(host, 'minimal'),
        collective: { ...this.collective.minimal, isActive: this.collective.isActive },
        user: submittedByUserCollective.minimal,
        fromCollective: fromCollective.minimal,
        expense: this.info,
        transaction: transaction?.info,
        amountInHostCurrency: Math.abs(transaction?.info?.amountInHostCurrency),
        payoutMethod: payoutMethod && pick(payoutMethod.dataValues, ['id', 'type', 'data']),
        items:
          !isEmpty(items) &&
          items.map(item => ({
            id: item.id,
            incurredAt: item.incurredAt,
            description: item.description,
            amount: item.amount,
            currency: item.currency,
            expenseCurrencyFxRate: item.expenseCurrencyFxRate,
            expenseCurrencyFxRateSource: item.expenseCurrencyFxRateSource,
            url: item.url,
          })),
      },
    });
  };

  getSubmitterUser = async function () {
    if (!this.user) {
      this.user = await User.findByPk(this.UserId);
    }
    return this.user;
  };

  setAndSavePaymentMethodIfMissing = async function () {
    let paymentMethod = await this.getPaymentMethod();
    if (!paymentMethod) {
      paymentMethod = await this.fetchPaymentMethod();
      if (paymentMethod) {
        this.setPaymentMethod(paymentMethod);
        await this.save();
      }
    }
    return this;
  };

  fetchPaymentMethod = async function () {
    const collective = this.collective || (await this.getCollective());
    const host = (await this.getHost()) || (await collective.getHostCollective());

    const payoutMethod = this.payoutMethod || (await this.getPayoutMethod());
    if (payoutMethod?.type === PayoutMethodTypes.PAYPAL) {
      return host.findOrCreatePaymentMethod(PAYMENT_METHOD_SERVICE.PAYPAL, PAYMENT_METHOD_TYPE.PAYOUT);
    } else if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
      return host.findOrCreatePaymentMethod(PAYMENT_METHOD_SERVICE.WISE, PAYMENT_METHOD_TYPE.BANK_TRANSFER);
    } else if (payoutMethod?.type === PayoutMethodTypes.ACCOUNT_BALANCE) {
      return collective.findOrCreatePaymentMethod(
        PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        PAYMENT_METHOD_TYPE.COLLECTIVE,
      );
    }

    const virtualCard = this.virtualCard || (await this.getVirtualCard());
    if (virtualCard) {
      return host.findOrCreatePaymentMethod(PAYMENT_METHOD_SERVICE.STRIPE, PAYMENT_METHOD_TYPE.VIRTUAL_CARD);
    }
  };

  markAsPaid = async function ({ user = null, isManualPayout = false, skipActivity = false } = {}) {
    const collective = this.collective || (await this.getCollective());
    const lastEditedById = user?.id || this.lastEditedById;
    await this.update({
      status: ExpenseStatus.PAID,
      lastEditedById,
      HostCollectiveId: collective.HostCollectiveId,
    });

    // Update transactions settlement
    if (this.type === ExpenseType.SETTLEMENT || this.data?.['isPlatformTipSettlement']) {
      await TransactionSettlement.markExpenseAsSettled(this);
    }

    try {
      await this.createContributorMember();
    } catch (e) {
      // Don't crash if member can't be added as a contributor
      reportErrorToSentry(e);
      logger.error(`Error when trying to add MEMBER in setPaid for expense ${this.id}: ${e}`);
    }

    if (!skipActivity) {
      user = user ?? (await User.findByPk(lastEditedById));
      await this.createActivity(ActivityTypes.COLLECTIVE_EXPENSE_PAID, user, { isManualPayout });
    }
  };

  /**
   * Register the payee as a `CONTRIBUTOR` member if it's a USER
   */
  createContributorMember = async function () {
    // This will return `null` if the payee is not a user
    const fromUser = await User.findOne({ where: { CollectiveId: this.FromCollectiveId } });
    if (!fromUser) {
      return null;
    }

    const collective = this.collective || (await this.getCollective());
    await collective.addUserWithRole(fromUser, roles.CONTRIBUTOR).catch(e => {
      // Ignore if member already exists
      if (e.name === 'SequelizeUniqueConstraintError') {
        logger.debug('User ', fromUser.id, 'is already a contributor');
      }
    });
  };

  setProcessing = function (lastEditedById) {
    this.status = ExpenseStatus.PROCESSING;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  setError = function (lastEditedById) {
    this.status = ExpenseStatus.ERROR;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  verify = async function (remoteUser) {
    if (this.status !== ExpenseStatus.UNVERIFIED) {
      throw new Error(`Expense needs to be UNVERIFIED in order to be verified.`);
    }

    await this.update({ status: ExpenseStatus.PENDING });

    // Technically the expense was already created, but it was a draft. It truly becomes visible
    // for everyone (especially admins) at this point, so it's the right time to trigger `COLLECTIVE_EXPENSE_CREATED`
    await this.createActivity(ActivityTypes.COLLECTIVE_EXPENSE_CREATED, remoteUser).catch(e => {
      logger.error('An error happened when creating the COLLECTIVE_EXPENSE_CREATED activity', e);
      reportErrorToSentry(e);
    });

    // In case the expense is subject to tax forms
    try {
      const collective = this.collective || (await this.getCollective());
      const host = (await this.getHost()) || (await collective.getHostCollective());
      const fromCollective = this.fromCollective || (await Collective.findByPk(this.FromCollectiveId));
      await this.updateTaxFormStatus(host, fromCollective, remoteUser);
    } catch (e) {
      reportErrorToSentry(e);
      logger.error('An error happened when updating the tax form status', e);
    }
  };

  /**
   * A function that checks an updates the expense status. Must run whenever creating a new expense,
   * when the amount/payout method change, or when an invited expense goes to pending.
   *
   * @returns the LegalDocument, or null if none required
   */
  updateTaxFormStatus = async function (host: Collective, payee: Collective, user: User, { UserTokenId = null } = {}) {
    if (!host) {
      return null;
    }

    // Check if host is connected to the tax form system
    const requiredLegalDocument = await host.getRequiredLegalDocuments({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
    if (!requiredLegalDocument) {
      return null;
    }

    // Check if tax form is required for expense
    const taxFormRequiredForExpenseIds = await SQLQueries.getTaxFormsRequiredForExpenses([this.id]);
    if (!taxFormRequiredForExpenseIds.has(this.id)) {
      return null;
    }

    // Check if tax form request already exists or create a new one
    return LegalDocument.createTaxFormRequestToCollectiveIfNone(payee, user, {
      UserTokenId,
      ExpenseId: this.id,
      HostCollectiveId: host.id,
    });
  };

  /**
   * Returns the PayoutMethod.type based on the legacy `payoutMethod`
   */
  getPayoutMethodTypeFromLegacy = function () {
    return Expense.getPayoutMethodTypeFromLegacy(this.legacyPayoutMethod);
  };

  // Getters

  get info(): NonAttribute<
    Partial<Expense> & {
      category: string;
      taxes: ExpenseTaxDefinition[];
      grossAmount: number;
    }
  > {
    const taxes = get(this.data, 'taxes', []) as ExpenseTaxDefinition[];
    return {
      type: this.type,
      id: this.id,
      UserId: this.UserId,
      CollectiveId: this.CollectiveId,
      FromCollectiveId: this.FromCollectiveId,
      HostCollectiveId: this.HostCollectiveId,
      AccountingCategoryId: this.AccountingCategoryId,
      currency: this.currency,
      amount: this.amount,
      description: this.description,
      /** @deprecated - now using `tags` */
      category: this.tags?.[1],
      tags: this.tags,
      legacyPayoutMethod: this.legacyPayoutMethod,
      privateMessage: this.privateMessage,
      lastEditedById: this.lastEditedById,
      status: this.status,
      incurredAt: this.incurredAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      taxes,
      grossAmount: Expense.computeTotalAmountForExpense(this.items, []), // Compute without tax
    };
  }

  // Static methods

  /**
   * Get the total amount of all expenses filed by the given UserId
   * Converts the amount to baseCurrency if needed
   * @return amount in base currency (int)
   * @param {*} userId
   * @param {*} baseCurrency
   * @param {*} since
   * @param {*} until
   */
  static getTotalExpensesFromUserIdInBaseCurrency = async function (userId, baseCurrency, since, until = new Date()) {
    const userExpenses = await Expense.findAll({
      attributes: ['currency', 'amount', 'status', 'updatedAt'],
      where: {
        UserId: userId,
        createdAt: {
          [Op.between]: [since, until], // between means since >= x <= until
        },
      },
    });
    const arr = [];
    for (const expense of userExpenses) {
      const entry = {
        currency: expense.currency,
        amount: expense.amount,
      };
      if (expense.status === ExpenseStatus.PAID) {
        entry['date'] = expense.updatedAt;
      }

      if (expense.status !== ExpenseStatus.REJECTED) {
        arr.push(entry);
      }
    }
    return reduceArrayToCurrency(arr, baseCurrency);
  };

  /**
   * Returns the legacy `payoutMethod` based on the new `PayoutMethod` type
   */
  static getLegacyPayoutMethodTypeFromPayoutMethod = function (payoutMethod: PayoutMethod | null): 'paypal' | 'other' {
    if (payoutMethod && payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      return 'paypal';
    } else {
      return 'other';
    }
  };

  /**
   * Returns the PayoutMethod.type based on the legacy `payoutMethod`
   */
  static getPayoutMethodTypeFromLegacy = function (legacyPayoutMethod: string): PayoutMethodTypes {
    return legacyPayoutMethod === 'paypal' ? PayoutMethodTypes.PAYPAL : PayoutMethodTypes.OTHER;
  };

  // TODO: can be deprecated and replaced by getCollectiveExpensesTags
  static getMostPopularExpenseTagsForCollective = async function (collectiveId, limit = 100) {
    return sequelize.query(
      `
      SELECT UNNEST(tags) AS id, UNNEST(tags) AS tag, COUNT(id)
      FROM "Expenses"
      WHERE "CollectiveId" = $collectiveId
      AND "deletedAt" IS NULL
      AND "status" NOT IN ('SPAM', 'DRAFT', 'UNVERIFIED')
      GROUP BY UNNEST(tags)
      ORDER BY count DESC
      LIMIT $limit
    `,
      {
        type: QueryTypes.SELECT,
        bind: { collectiveId, limit },
      },
    );
  };

  static getCollectiveExpensesTags = async function (
    collective,
    { dateFrom = null, dateTo = null, limit = 100, includeChildren = false } = {},
  ): Promise<Array<{ label: string; count: number; amount: number; currency: SupportedCurrency }>> {
    const noTag = 'no tag';
    const collectiveIds = [collective.id];
    if (includeChildren) {
      const collectiveChildrenIds = await collective
        .getChildren({ attributes: ['id'] })
        .then(children => children.map(child => child.id));
      collectiveIds.push(...collectiveChildrenIds);
    }

    const wheres = [
      {
        CollectiveId: { [Op.in]: collectiveIds },
        FromCollectiveId: { [Op.notIn]: collectiveIds },
        type: 'DEBIT',
        kind: 'EXPENSE', // net=false don't include related PAYMENT_PROCESSOR_FEE
        RefundTransactionId: null,
      },
    ];
    if (dateFrom) {
      wheres.push(
        sequelize.where(
          sequelize.literal(`COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")`),
          Op.gte,
          isMoment(dateFrom) ? dateFrom.toDate() : dateFrom,
        ),
      );
    }
    if (dateTo) {
      wheres.push(
        sequelize.where(
          sequelize.literal(`COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")`),
          Op.lte,
          isMoment(dateTo) ? dateTo.toDate() : dateTo,
        ),
      );
    }

    return (await models.Transaction.findAll({
      where: { [Op.and]: wheres },
      attributes: [
        [
          sequelize.fn('TRIM', sequelize.fn('UNNEST', sequelize.literal(`COALESCE("Expense".tags, '{"${noTag}"}')`))),
          'label',
        ],
        [sequelize.fn('COUNT', sequelize.literal('DISTINCT "Expense".id')), 'count'],
        [sequelize.fn('ABS', sequelize.fn('SUM', sequelize.literal('"Transaction".amount'))), 'amount'],
        [sequelize.literal('"Transaction".currency'), 'currency'],
      ],
      include: [
        {
          model: models.Expense,
          required: true,
          where: { status: 'PAID' },
          attributes: [],
        },
      ],
      group: ['label', '"Transaction".currency'],
      order: [[sequelize.literal('ABS(SUM("Transaction".amount))'), 'DESC']],
      limit: limit,
      raw: true,
    })) as unknown as Array<{ label: string; count: number; amount: number; currency: SupportedCurrency }>;
  };

  static getCollectiveExpensesTagsTimeSeries = async function (
    collective,
    timeUnit,
    { dateFrom = null, dateTo = null, includeChildren = false } = {},
  ) {
    const noTag = 'no tag';
    const collectiveIds = [collective.id];
    if (includeChildren) {
      const collectiveChildrenIds = await collective
        .getChildren({ attributes: ['id'] })
        .then(children => children.map(child => child.id));
      collectiveIds.push(...collectiveChildrenIds);
    }

    const wheres = [
      {
        CollectiveId: { [Op.in]: collectiveIds },
        FromCollectiveId: { [Op.notIn]: collectiveIds },
        type: 'DEBIT',
        kind: 'EXPENSE', // net=false don't include related PAYMENT_PROCESSOR_FEE
        RefundTransactionId: null,
      },
    ];
    if (dateFrom) {
      wheres.push(
        sequelize.where(
          sequelize.literal(`COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")`),
          Op.gte,
          isMoment(dateFrom) ? dateFrom.toDate() : dateFrom,
        ),
      );
    }
    if (dateTo) {
      wheres.push(
        sequelize.where(
          sequelize.literal(`COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")`),
          Op.lte,
          isMoment(dateTo) ? dateTo.toDate() : dateTo,
        ),
      );
    }

    return (await models.Transaction.findAll({
      where: { [Op.and]: wheres },
      attributes: [
        [
          sequelize.fn(
            'DATE_TRUNC',
            timeUnit,
            sequelize.literal(`COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")`),
          ),
          'date',
        ],
        [
          sequelize.fn('TRIM', sequelize.fn('UNNEST', sequelize.literal(`COALESCE("Expense".tags, '{"${noTag}"}')`))),
          'label',
        ],
        [sequelize.fn('COUNT', sequelize.literal('DISTINCT "Expense".id')), 'count'],
        [sequelize.fn('ABS', sequelize.fn('SUM', sequelize.literal('"Transaction".amount'))), 'amount'],
        [sequelize.literal('"Transaction".currency'), 'currency'],
      ],
      include: [
        {
          model: models.Expense,
          required: true,
          where: { status: 'PAID' },
          attributes: [],
        },
      ],
      group: ['date', 'label', '"Transaction".currency'],
      order: [
        ['date', 'DESC'],
        [sequelize.fn('ABS', sequelize.fn('SUM', sequelize.literal('"Transaction".amount'))), 'DESC'],
      ],
      raw: true,
    })) as unknown as Array<{ date: Date; label: string; count: number; amount: number; currency: SupportedCurrency }>;
  };

  static findPendingCardCharges = async function ({ where = {}, include = [] } = {}) {
    const expenses = await Expense.findAll({
      where: {
        ...where,
        type: ExpenseType.CHARGE,
        status: 'PAID',
        '$items.url$': { [Op.eq]: null },
      },
      include: [
        ...include,
        { model: ExpenseItem, as: 'items', required: true },
        { model: Transaction, as: 'Transactions' },
      ],
    });

    return expenses.filter(expense => expense?.Transactions?.some(t => t.isRefund) === false);
  };

  static verifyUserExpenses = async function (user) {
    const expenses = await Expense.findAll({
      where: {
        UserId: user.id,
        status: ExpenseStatus.UNVERIFIED,
      },
    });

    return Promise.all(expenses.map(expense => expense.verify(user)));
  };

  static computeTotalAmountForExpense = (items: Partial<ExpenseItem>[], taxes: ExpenseTaxDefinition[]): number => {
    return Math.round(
      sumBy(items, item => {
        const amountInCents = Math.round(item.amount * (item.expenseCurrencyFxRate || 1));
        const totalTaxes = sumBy(taxes, tax => amountInCents * tax.rate);
        return amountInCents + totalTaxes;
      }),
    );
  };
}

Expense.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    UserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      allowNull: true,
    },

    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL', // Collective deletion will fail if it has expenses
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    payeeLocation: {
      type: DataTypes.JSONB,
      allowNull: true,
      validate: {
        isValidLocation(value) {
          if (!value) {
            return true;
          }

          // Validate keys
          const validKeys = ['address', 'country', 'name', 'lat', 'long', 'structured'];
          Object.keys(value).forEach(key => {
            if (!validKeys.includes(key)) {
              throw new Error(`Invalid location key: ${key}`);
            }
          });

          // Validate values
          if (value.country && !validator.isISO31661Alpha2(value.country)) {
            throw new Error('Invalid Country ISO');
          }
        },
      },
    },

    data: DataTypes.JSONB,

    AccountingCategoryId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'AccountingCategories' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
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

    InvoiceFileId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'UploadedFiles',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    currency: CustomDataTypes(DataTypes).currency,

    amount: {
      type: DataTypes.INTEGER,
      validate: { min: 1 },
      allowNull: false,
    },

    description: {
      type: DataTypes.STRING,
      allowNull: false,
      set(description: string) {
        this.setDataValue('description', description.replace(/\s+/g, ' ').trim());
      },
    },

    longDescription: {
      type: DataTypes.TEXT,
      set(value: string) {
        if (value) {
          const cleanHtml = sanitizeHTML(value, optsSanitizeHtmlForSimplified).trim();
          this.setDataValue('longDescription', cleanHtml || null);
        } else {
          this.setDataValue('longDescription', null);
        }
      },
    },

    /**
     * @deprecated Now using PaymentMethodId. The reason why this hadn't been removed yet
     * is because we'd need to migrate the legacy `donation` payout types that exist in the
     * DB and that `PayoutMethod` has no equivalent for.
     */
    legacyPayoutMethod: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          // donation is deprecated but we keep it in the model because of existing entries
          args: [['paypal', 'manual', 'donation', 'other']],
          msg: 'Must be paypal or other. Deprecated: donation and manual.',
        },
      },
      allowNull: false,
      defaultValue: 'manual',
    },

    PayoutMethodId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'PayoutMethods' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    PaymentMethodId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'PaymentMethods' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    VirtualCardId: {
      type: DataTypes.STRING,
      references: { key: 'id', model: 'VirtualCards' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    privateMessage: {
      type: DataTypes.TEXT,
      set(value: string | null) {
        if (value) {
          const cleanHtml = sanitizeHTML(value, optsSanitizeHtmlForSimplified).trim();
          this.setDataValue('privateMessage', cleanHtml || null);
        } else {
          this.setDataValue('privateMessage', null);
        }
      },
    },

    invoiceInfo: DataTypes.TEXT,

    lastEditedById: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: ExpenseStatus.PENDING,
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.keys(ExpenseStatus)],
          msg: `Must be in ${Object.keys(ExpenseStatus)}`,
        },
      },
    },

    type: {
      type: DataTypes.ENUM(...Object.keys(ExpenseType)),
      defaultValue: ExpenseType.UNCLASSIFIED,
    },

    feesPayer: {
      type: DataTypes.ENUM('COLLECTIVE', 'PAYEE'),
      defaultValue: 'COLLECTIVE',
      allowNull: false,
    },

    incurredAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },

    deletedAt: {
      type: DataTypes.DATE,
    },

    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      set(tags: string[] | null) {
        this.setDataValue('tags', sanitizeTags(tags));
      },
      validate: { validateTags },
    },

    RecurringExpenseId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'RecurringExpenses' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    onHold: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },

    reference: {
      type: DataTypes.STRING,
      set(reference: string | null) {
        this.setDataValue('reference', reference?.trim() || null);
      },
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'Expenses',
    hooks: {
      async afterDestroy(expense: Expense) {
        // Not considering ExpensesAttachedFiles because they don't support soft delete (they should)
        const promises = [
          ExpenseItem.destroy({ where: { ExpenseId: expense.id } }),
          models.Comment.destroy({ where: { ExpenseId: expense.id } }),
          models.TransactionsImportRow.update(
            { ExpenseId: null, status: 'PENDING' },
            { where: { ExpenseId: expense.id } },
          ),
        ];

        if (expense.RecurringExpenseId) {
          promises.push(RecurringExpense.destroy({ where: { id: expense.RecurringExpenseId } }));
        }
        if (expense.InvoiceFileId) {
          promises.push(UploadedFile.destroy({ where: { id: expense.InvoiceFileId } }));
        }

        await Promise.all(promises);
      },
    },
  },
);

Temporal(Expense, sequelize);

export default Expense;
