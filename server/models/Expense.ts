import { get, isEmpty, pick } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';
import Temporal from 'sequelize-temporal';
import validator from 'validator';

import { roles } from '../constants';
import ActivityTypes from '../constants/activities';
import ExpenseStatus from '../constants/expense_status';
import ExpenseType from '../constants/expense_type';
import { reduceArrayToCurrency } from '../lib/currency';
import logger from '../lib/logger';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Model, Op, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import { computeDatesAsISOStrings } from '../lib/utils';
import CustomDataTypes from '../models/DataTypes';

import { ExpenseAttachedFile } from './ExpenseAttachedFile';
import { ExpenseItem } from './ExpenseItem';
import PayoutMethod, { PayoutMethodTypes } from './PayoutMethod';
import { RecurringExpense } from './RecurringExpense';
import User from './User';
import VirtualCard from './VirtualCard';

// Options for sanitizing private messages
const PRIVATE_MESSAGE_SANITIZE_OPTS = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

const { models } = sequelize;

class Expense extends Model<InferAttributes<Expense>, InferCreationAttributes<Expense>> {
  public declare readonly id: CreationOptional<number>;
  public declare UserId: ForeignKey<User['id']>;
  public declare lastEditedById: ForeignKey<User['id']>;
  public declare HostCollectiveId: number;
  public declare FromCollectiveId: number;
  public declare CollectiveId: number;
  public declare PayoutMethodId: ForeignKey<PayoutMethod['id']>;
  public declare VirtualCardId: ForeignKey<VirtualCard['id']>;
  public declare RecurringExpenseId: ForeignKey<RecurringExpense['id']>;

  public declare payeeLocation: Record<string, unknown>; // TODO This can be typed
  public declare data: Record<string, unknown>;
  public declare currency: string;
  public declare amount: number;
  public declare description: string;
  public declare longDescription: CreationOptional<string>;
  public declare privateMessage: CreationOptional<string>;
  public declare invoiceInfo: CreationOptional<string>;
  public declare legacyPayoutMethod: 'paypal' | 'manual' | 'donation' | 'other';

  public declare status: keyof typeof ExpenseStatus;
  public declare type: ExpenseType;
  public declare feesPayer: 'COLLECTIVE' | 'PAYEE';
  public declare tags: string[];

  public declare incurredAt: CreationOptional<Date>;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare Transactions?: (typeof models.Transaction)[];
  public declare collective?: typeof models.Collective;
  public declare fromCollective?: typeof models.Collective;
  public declare host?: typeof models.Collective;
  public declare User?: User;
  public declare PayoutMethod?: PayoutMethod;
  public declare virtualCard?: VirtualCard;
  public declare items?: ExpenseItem[];
  public declare attachedFiles?: ExpenseAttachedFile[];

  // Association getters
  declare getCollective: BelongsToGetAssociationMixin<typeof models.Collective>;
  declare getItems: HasManyGetAssociationsMixin<ExpenseItem>;
  declare getPayoutMethod: BelongsToGetAssociationMixin<PayoutMethod>;
  declare getRecurringExpense: BelongsToGetAssociationMixin<RecurringExpense>;
  declare getTransactions: BelongsToGetAssociationMixin<typeof models.Transaction>;
  declare getVirtualCard: BelongsToGetAssociationMixin<typeof models.VirtualCard>;

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
    data: Record<string, unknown> | null = {},
  ) {
    const submittedByUser = await this.getSubmitterUser();
    const submittedByUserCollective = await models.Collective.findByPk(submittedByUser.CollectiveId);
    const fromCollective = this.fromCollective || (await models.Collective.findByPk(this.FromCollectiveId));
    if (!this.collective) {
      this.collective = await this.getCollective();
    }
    const host = await this.collective.getHostCollective(); // may be null
    const payoutMethod = await this.getPayoutMethod();
    const items = this.items || this.data?.items || (await this.getItems());
    const transaction =
      this.status === ExpenseStatus.PAID &&
      (await models.Transaction.findOne({ where: { type: 'DEBIT', ExpenseId: this.id } }));
    return models.Activity.create({
      type,
      UserId: user?.id,
      CollectiveId: this.collective.id,
      FromCollectiveId: this.FromCollectiveId,
      HostCollectiveId: host?.id,
      ExpenseId: this.id,
      TransactionId: transaction?.id,
      data: {
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
            url: item.url,
          })),
      },
    });
  };

  getSubmitterUser = async function () {
    if (!this.user) {
      this.user = await models.User.findByPk(this.UserId);
    }
    return this.user;
  };

  setPaid = async function (editedById) {
    const collective = this.collective || (await this.getCollective());
    const lastEditedById = editedById || this.lastEditedById;
    await this.update({ status: ExpenseStatus.PAID, lastEditedById, HostCollectiveId: collective.HostCollectiveId });

    // Update transactions settlement
    if (this.type === ExpenseType.SETTLEMENT || this.data?.['isPlatformTipSettlement']) {
      await models.TransactionSettlement.markExpenseAsSettled(this);
    }

    try {
      await this.createContributorMember();
    } catch (e) {
      // Don't crash if member can't be added as a contributor
      reportErrorToSentry(e);
      logger.error(`Error when trying to add MEMBER in setPaid for expense ${this.id}: ${e}`);
    }
  };

  /**
   * Register the payee as a `CONTRIBUTOR` member if it's a USER
   */
  createContributorMember = async function () {
    // This will return `null` if the payee is not a user
    const fromUser = await models.User.findOne({ where: { CollectiveId: this.FromCollectiveId } });
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

  /**
   * Returns the PayoutMethod.type based on the legacy `payoutMethod`
   */
  getPayoutMethodTypeFromLegacy = function () {
    return Expense.getPayoutMethodTypeFromLegacy(this.legacyPayoutMethod);
  };

  // Getters

  get info(): NonAttribute<Partial<Expense> & { category: string }> {
    return {
      type: this.type,
      id: this.id,
      UserId: this.UserId,
      CollectiveId: this.CollectiveId,
      FromCollectiveId: this.FromCollectiveId,
      HostCollectiveId: this.HostCollectiveId,
      currency: this.currency,
      amount: this.amount,
      description: this.description,
      category: this.tags?.[1],
      tags: this.tags,
      legacyPayoutMethod: this.legacyPayoutMethod,
      privateMessage: this.privateMessage,
      lastEditedById: this.lastEditedById,
      status: this.status,
      incurredAt: this.incurredAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
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
  ) {
    const noTag = 'no tag';
    const collectiveIds = [collective.id];
    if (includeChildren) {
      const collectiveChildrenIds = await collective
        .getChildren({ attributes: ['id'] })
        .then(children => children.map(child => child.id));
      collectiveIds.push(...collectiveChildrenIds);
    }
    return sequelize.query(
      `
      SELECT
        TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))) AS label,
        COUNT(e."id") as "count",
        ABS(SUM(t."amount")) as "amount",
        t."currency" as "currency"
      FROM "Expenses" e
      INNER JOIN "Transactions" t
        ON t."ExpenseId" = e."id"
      INNER JOIN "Collectives" c
        ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
      WHERE e."CollectiveId" = c."id"
        AND e."deletedAt" IS NULL
        AND e."status" = 'PAID'
        AND t."CollectiveId" IN (:collectiveIds)
        AND t."FromCollectiveId" NOT IN (:collectiveIds)
        AND t."RefundTransactionId" IS NULL
        AND t."type" = 'DEBIT'
        AND t."deletedAt" IS NULL
        ${dateFrom ? `AND t."createdAt" >= :startDate` : ``}
        ${dateTo ? `AND t."createdAt" <= :endDate` : ``}
      GROUP BY TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))), t."currency"
      ORDER BY ABS(SUM(t."amount")) DESC
      LIMIT :limit
    `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          collectiveIds,
          limit,
          ...computeDatesAsISOStrings(dateFrom, dateTo),
        },
      },
    );
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
    return sequelize.query(
      `
      SELECT
        DATE_TRUNC(:timeUnit, t."createdAt") AS "date",
        TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))) AS label,
        COUNT(e."id") as "count",
        ABS(SUM(t."amount")) as "amount",
        t."currency" as "currency"
      FROM "Expenses" e
      INNER JOIN "Transactions" t
        ON t."ExpenseId" = e."id" AND t."deletedAt" IS NULL
      INNER JOIN "Collectives" c
        ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
      WHERE e."CollectiveId" = c."id"
        AND e."deletedAt" IS NULL
        AND e."status" = 'PAID'
        AND t."CollectiveId" IN (:collectiveIds)
        AND t."FromCollectiveId" NOT IN (:collectiveIds)
        AND t."RefundTransactionId" IS NULL
        AND t."type" = 'DEBIT'
        ${dateFrom ? `AND t."createdAt" >= :startDate` : ``}
        ${dateTo ? `AND t."createdAt" <= :endDate` : ``}
      GROUP BY DATE_TRUNC(:timeUnit, t."createdAt"), TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))), t."currency"
      ORDER BY DATE_TRUNC(:timeUnit, t."createdAt") DESC, ABS(SUM(t."amount")) DESC
    `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          collectiveIds,
          timeUnit,
          ...computeDatesAsISOStrings(dateFrom, dateTo),
        },
      },
    );
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
        { model: models.ExpenseItem, as: 'items', required: true },
        { model: models.Transaction, as: 'Transactions' },
      ],
    });

    return expenses.filter(expense => expense?.Transactions?.some(t => t.isRefund) === false);
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
          const cleanHtml = sanitizeHTML(value, PRIVATE_MESSAGE_SANITIZE_OPTS).trim();
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
          const cleanHtml = sanitizeHTML(value, PRIVATE_MESSAGE_SANITIZE_OPTS).trim();
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
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'Expenses',
    hooks: {
      afterDestroy(expense) {
        return models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      },
    },
  },
);

Temporal(Expense, sequelize);

export default Expense;
