import { get, isEmpty, pick } from 'lodash';
import Temporal from 'sequelize-temporal';
import { isISO31661Alpha2 } from 'validator';

import { roles } from '../constants';
import status from '../constants/expense_status';
import expenseType from '../constants/expense_type';
import { TransactionTypes } from '../constants/transactions';
import { reduceArrayToCurrency } from '../lib/currency';
import logger from '../lib/logger';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Op, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import { computeDatesAsISOStrings } from '../lib/utils';
import CustomDataTypes from '../models/DataTypes';

import { PayoutMethodTypes } from './PayoutMethod';

// Options for sanitizing private messages
const PRIVATE_MESSAGE_SANITIZE_OPTS = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

function defineModel() {
  const { models } = sequelize;

  const Expense = sequelize.define(
    'Expense',
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
            if (value.country && !isISO31661Alpha2(value.country)) {
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
        set(description) {
          this.setDataValue('description', description.replace(/\s+/g, ' ').trim());
        },
      },

      longDescription: {
        type: DataTypes.TEXT,
        set(value) {
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
        set(value) {
          if (value) {
            const cleanHtml = sanitizeHTML(value, PRIVATE_MESSAGE_SANITIZE_OPTS).trim();
            this.setDataValue('privateMessage', cleanHtml || null);
          } else {
            this.setDataValue('privateMessage', null);
          }
        },
      },

      invoiceInfo: DataTypes.TEXT,
      vat: DataTypes.INTEGER,

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
        defaultValue: status.PENDING,
        allowNull: false,
        validate: {
          isIn: {
            args: [Object.keys(status)],
            msg: `Must be in ${Object.keys(status)}`,
          },
        },
      },

      type: {
        type: DataTypes.ENUM(Object.keys(expenseType)),
        defaultValue: expenseType.UNCLASSIFIED,
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
        set(tags) {
          const sanitizedTags = sanitizeTags(tags);
          if (!sanitizedTags?.length) {
            this.setDataValue('tags', null);
          } else {
            this.setDataValue('tags', sanitizedTags);
          }
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
      paranoid: true,

      getterMethods: {
        info() {
          return {
            type: TransactionTypes.DEBIT,
            id: this.id,
            UserId: this.UserId,
            CollectiveId: this.CollectiveId,
            FromCollectiveId: this.FromCollectiveId,
            currency: this.currency,
            amount: this.amount,
            description: this.description,
            category: this.tags?.[1],
            tags: this.tags,
            legacyPayoutMethod: this.legacyPayoutMethod,
            vat: this.vat,
            privateMessage: this.privateMessage,
            lastEditedById: this.lastEditedById,
            status: this.status,
            incurredAt: this.incurredAt,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },
        public() {
          return {
            type: TransactionTypes.DEBIT,
            id: this.id,
            UserId: this.UserId,
            CollectiveId: this.CollectiveId,
            FromCollectiveId: this.FromCollectiveId,
            currency: this.currency,
            amount: this.amount,
            description: this.description,
            category: this.tags?.[1],
            tags: this.tags,
            legacyPayoutMethod: this.legacyPayoutMethod,
            vat: this.vat,
            lastEditedById: this.lastEditedById,
            status: this.status,
            incurredAt: this.incurredAt,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },
      },
      hooks: {
        afterDestroy(expense) {
          return models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
        },
      },
    },
  );

  /**
   * Instance Methods
   */

  /**
   * Create an activity to describe an expense update.
   * @param {string} type: type of the activity, see `constants/activities.js`
   * @param {object} user: the user who triggered the activity. Leave blank for system activities.
   */
  Expense.prototype.createActivity = async function (type, user, data) {
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
      this.status === status.PAID &&
      (await models.Transaction.findOne({
        where: { type: 'DEBIT', ExpenseId: this.id },
      }));
    return models.Activity.create({
      type,
      UserId: user?.id,
      CollectiveId: this.collective.id,
      ExpenseId: this.id,
      data: {
        ...pick(data, ['isManualPayout', 'error', 'payee', 'draftKey', 'inviteUrl', 'recipientNote', 'message']),
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

  Expense.prototype.getSubmitterUser = async function () {
    if (!this.user) {
      this.user = await models.User.findByPk(this.UserId);
    }
    return this.user;
  };

  Expense.prototype.setPaid = async function (editedById) {
    const collective = this.collective || (await this.getCollective());
    const lastEditedById = editedById || this.lastEditedById;
    await this.update({ status: status.PAID, lastEditedById, HostCollectiveId: collective.HostCollectiveId });

    // Update transactions settlement
    if (this.type === expenseType.SETTLEMENT || this.data?.['isPlatformTipSettlement']) {
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
  Expense.prototype.createContributorMember = async function () {
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

  Expense.prototype.setProcessing = function (lastEditedById) {
    this.status = status.PROCESSING;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.setError = function (lastEditedById) {
    this.status = status.ERROR;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  /**
   * Returns the PayoutMethod.type based on the legacy `payoutMethod`
   */
  Expense.prototype.getPayoutMethodTypeFromLegacy = function () {
    return Expense.getPayoutMethodTypeFromLegacy(this.legacyPayoutMethod);
  };

  /**
   * Get the total amount of all expenses filed by the given UserId
   * Converts the amount to baseCurrency if needed
   * @return amount in base currency (int)
   * @param {*} userId
   * @param {*} baseCurrency
   * @param {*} since
   * @param {*} until
   */
  Expense.getTotalExpensesFromUserIdInBaseCurrency = async function (userId, baseCurrency, since, until = new Date()) {
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
      if (expense.status === status.PAID) {
        entry.date = expense.updatedAt;
      }

      if (expense.status !== status.REJECTED) {
        arr.push(entry);
      }
    }
    return reduceArrayToCurrency(arr, baseCurrency);
  };

  /**
   * Returns the legacy `payoutMethod` based on the new `PayoutMethod` type
   */
  Expense.getLegacyPayoutMethodTypeFromPayoutMethod = function (payoutMethod) {
    if (payoutMethod && payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      return 'paypal';
    } else {
      return 'other';
    }
  };

  /**
   * Returns the PayoutMethod.type based on the legacy `payoutMethod`
   */
  Expense.getPayoutMethodTypeFromLegacy = function (legacyPayoutMethod) {
    return legacyPayoutMethod === 'paypal' ? PayoutMethodTypes.PAYPAL : PayoutMethodTypes.OTHER;
  };

  Expense.getCollectiveExpensesTags = async function (
    collectiveId,
    { dateFrom = null, dateTo = null, limit = 100 } = {},
  ) {
    const noTag = 'no tag';
    return sequelize.query(
      `
      SELECT TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))) AS id,
      TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))) AS tag,
      COUNT(e."id") as "count",
      ABS(SUM(t."amountInHostCurrency")) as "amount",
      t."hostCurrency" as "currency"
      FROM "Expenses" e
      INNER JOIN "Transactions" t ON t."ExpenseId" = e."id"
      WHERE e."CollectiveId" = $collectiveId
      AND e."deletedAt" IS NULL
      AND e."status" = 'PAID'
      AND t."CollectiveId" = $collectiveId
      AND t."RefundTransactionId" IS NULL
      AND t."type" = 'DEBIT'
      AND t."deletedAt" IS NULL
      ${dateFrom ? `AND t."createdAt" >= $startDate` : ``}
      ${dateTo ? `AND t."createdAt" <= $endDate` : ``}
      GROUP BY TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))), t."hostCurrency"
      ORDER BY ABS(SUM(t."amountInHostCurrency")) DESC
      LIMIT $limit
    `,
      {
        type: QueryTypes.SELECT,
        bind: {
          collectiveId,
          limit,
          ...computeDatesAsISOStrings(dateFrom, dateTo),
        },
      },
    );
  };

  Expense.getCollectiveExpensesTagsTimeSeries = async function (
    collectiveId,
    timeUnit,
    { dateFrom = null, dateTo = null } = {},
  ) {
    const noTag = 'no tag';
    return sequelize.query(
      `
      SELECT DATE_TRUNC($timeUnit, t."createdAt") AS "date",
      TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))) AS label,
      COUNT(e."id") as "count",
      ABS(SUM(t."amountInHostCurrency")) as "amount",
      t."hostCurrency" as "currency"
      FROM "Expenses" e
      INNER JOIN "Transactions" t ON t."ExpenseId" = e."id"
      AND t."deletedAt" IS NULL
      WHERE e."CollectiveId" = $collectiveId
      AND e."deletedAt" IS NULL
      AND e."status" = 'PAID'
      AND t."CollectiveId" = $collectiveId
      AND t."RefundTransactionId" IS NULL
      AND t."type" = 'DEBIT'
      ${dateFrom ? `AND t."createdAt" >= $startDate` : ``}
      ${dateTo ? `AND t."createdAt" <= $endDate` : ``}
      GROUP BY DATE_TRUNC($timeUnit, t."createdAt"), TRIM(UNNEST(COALESCE(e."tags", '{"${noTag}"}'))), t."hostCurrency"
      ORDER BY DATE_TRUNC($timeUnit, t."createdAt") DESC, ABS(SUM(t."amountInHostCurrency")) DESC
    `,
      {
        type: QueryTypes.SELECT,
        bind: {
          collectiveId,
          timeUnit,
          ...computeDatesAsISOStrings(dateFrom, dateTo),
        },
      },
    );
  };

  Expense.findPendingCardCharges = async function ({ where = {}, include = [] } = {}) {
    const expenses = await Expense.findAll({
      where: {
        ...where,
        type: expenseType.CHARGE,
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

  Temporal(Expense, sequelize);

  return Expense;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Expense = defineModel();

export default Expense;
