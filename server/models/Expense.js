import { get, pick } from 'lodash';
import Temporal from 'sequelize-temporal';
import { isISO31661Alpha2 } from 'validator';

import status from '../constants/expense_status';
import expenseType from '../constants/expense_type';
import { TransactionTypes } from '../constants/transactions';
import { reduceArrayToCurrency } from '../lib/currency';
import { buildSanitizerOptions, sanitizeHTML, stripHTML } from '../lib/sanitize-html';
import { sanitizeTags, validateTags } from '../lib/tags';
import CustomDataTypes from '../models/DataTypes';

import { PayoutMethodTypes } from './PayoutMethod';
import models, { Op } from './';

// Options for sanitizing private messages
const PRIVATE_MESSAGE_SANITIZE_OPTS = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

export default function (Sequelize, DataTypes) {
  const Expense = Sequelize.define(
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
            const validKeys = ['address', 'country', 'name', 'lat', 'long'];
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

      privateMessage: {
        type: DataTypes.STRING,
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

      incurredAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },

      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },

      deletedAt: {
        type: DataTypes.DATE,
      },

      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        set(tags) {
          const sanitizedTags = sanitizeTags(tags);
          if (!tags || sanitizedTags.length === 0) {
            this.setDataValue('tags', null);
          } else {
            this.setDataValue('tags', sanitizedTags);
          }
        },
        validate: { validateTags },
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
            privateMessage: this.privateMessage && stripHTML(this.privateMessage),
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
    const submittedByUser = this.user || (await models.User.findByPk(this.UserId));
    const submittedByUserCollective = await models.Collective.findByPk(submittedByUser.CollectiveId);
    const fromCollective = this.fromCollective || (await models.Collective.findByPk(this.FromCollectiveId));
    if (!this.collective) {
      this.collective = await this.getCollective();
    }
    const host = await this.collective.getHostCollective(); // may be null
    const payoutMethod = await this.getPayoutMethod();
    const items = this.items || (await this.getItems());
    const transaction =
      this.status === status.PAID &&
      (await models.Transaction.findOne({
        where: { type: 'DEBIT', ExpenseId: this.id },
      }));
    await models.Activity.create({
      type,
      UserId: user?.id,
      CollectiveId: this.collective.id,
      ExpenseId: this.id,
      data: {
        ...pick(data, ['isManualPayout']),
        host: get(host, 'minimal'),
        collective: { ...this.collective.minimal, isActive: this.collective.isActive },
        user: submittedByUserCollective.minimal,
        fromCollective: fromCollective.minimal,
        expense: this.info,
        transaction: transaction.info,
        payoutMethod: payoutMethod && pick(payoutMethod.dataValues, ['id', 'type', 'data']),
        items: items.map(item => ({
          id: item.id,
          incurredAt: item.incurredAt,
          description: item.description,
          amount: item.amount,
          url: item.url,
        })),
      },
    });
  };

  Expense.prototype.setApproved = function (lastEditedById) {
    if (this.status === status.PAID) {
      throw new Error("Can't approve an expense that is PAID");
    }
    this.status = status.APPROVED;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.setRejected = function (lastEditedById) {
    if (this.status === status.PAID) {
      throw new Error("Can't reject an expense that is PAID");
    }
    this.status = status.REJECTED;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.setPaid = function (lastEditedById) {
    this.status = status.PAID;
    this.lastEditedById = lastEditedById;
    return this.save();
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

  Expense.getMostPopularExpenseTagsForCollective = async function (collectiveId, limit = 100) {
    return Sequelize.query(
      `
      SELECT UNNEST(tags) AS id, UNNEST(tags) AS tag, COUNT(id)
      FROM "Expenses"
      WHERE "CollectiveId" = $collectiveId
      AND "deletedAt" IS NULL
      GROUP BY UNNEST(tags)
      ORDER BY count DESC
      LIMIT $limit
    `,
      {
        type: Sequelize.QueryTypes.SELECT,
        bind: { collectiveId, limit },
      },
    );
  };

  Temporal(Expense, Sequelize);

  return Expense;
}
