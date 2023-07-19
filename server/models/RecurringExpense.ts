import config from 'config';
import { pick } from 'lodash-es';
import moment from 'moment';
import { DataTypes, Model } from 'sequelize';
import { v4 as uuid } from 'uuid';

import expenseStatus from '../constants/expense_status.js';
import { activities } from '../constants/index.js';
import { reportErrorToSentry } from '../lib/sentry.js';
import sequelize from '../lib/sequelize.js';

import Expense from './Expense.js';
import models, { Op } from './index.js';

export enum RecurringExpenseIntervals {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  QUARTER = 'quarter',
  YEAR = 'year',
}

interface RecurringExpenseAttributes {
  id: number;
  interval: RecurringExpenseIntervals;
  CollectiveId: number;
  FromCollectiveId: number;
  lastDraftedAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

type RecurringExpenseCreateAttributes =
  | Required<Pick<RecurringExpenseAttributes, 'interval' | 'CollectiveId' | 'FromCollectiveId'>>
  | Pick<RecurringExpenseAttributes, 'endsAt' | 'lastDraftedAt'>;

export class RecurringExpense extends Model<RecurringExpenseAttributes, RecurringExpenseCreateAttributes> {
  public declare id: number;
  public declare interval: string;
  public declare CollectiveId: number;
  public declare FromCollectiveId: number;
  public declare lastDraftedAt: Date;
  public declare endsAt: Date;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date;

  public static RecurringExpenseIntervals = RecurringExpenseIntervals;

  async getLastExpense(options = {}) {
    return models.Expense.findOne({
      ...options,
      where: { RecurringExpenseId: this.id },
      order: [['createdAt', 'DESC']],
    });
  }

  async createNextExpense() {
    const expense = await this.getLastExpense({
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.ExpenseItem, as: 'items' },
        { model: models.User, as: 'User' },
      ],
    });
    if (!expense) {
      throw new Error(`Could not find previous expense for RecurringExpense #${this.id}`);
    }

    const draftKey = process.env.OC_ENV === 'e2e' || process.env.OC_ENV === 'ci' ? 'draft-key' : uuid();
    const expenseFields = [
      'description',
      'longDescription',
      'tags',
      'type',
      'privateMessage',
      'invoiceInfo',
      'PayoutMethodId',
      'RecurringExpenseId',
      'UserId',
      'currency',
    ];
    const incurredAt = new Date();

    const draft = {
      ...pick(expense, expenseFields),
      FromCollectiveId: this.FromCollectiveId,
      CollectiveId: this.CollectiveId,
      lastEditedById: expense.UserId,
      incurredAt,
      amount: expense.amount,
      currency: expense.currency,
      data: {
        items: expense.items?.map(item => ({ ...pick(item, ['amount', 'description', 'url']), incurredAt })),
        payee: { id: expense.FromCollectiveId },
        invitedByCollectiveId: this.FromCollectiveId,
        draftKey,
        payeeLocation: expense.payeeLocation,
        customData: expense.data?.customData,
        taxes: expense.data?.taxes,
      },
      status: expenseStatus.DRAFT,
    };

    const draftedExpense = await models.Expense.create(draft);
    await this.update({ lastDraftedAt: incurredAt });

    // Payee is always an user of the website, we can redirect them to the signin page to make sure they're logged in
    const inviteUrl = `${config.host.website}/signin?next=/${expense.collective.slug}/expenses/${draftedExpense.id}?key=${draft.data.draftKey}`;
    await draftedExpense
      .createActivity(activities.COLLECTIVE_EXPENSE_RECURRING_DRAFTED, expense.User, {
        ...draftedExpense.data,
        inviteUrl,
        description: draftedExpense.description,
      })
      .catch(e => {
        console.error('An error happened when creating the COLLECTIVE_EXPENSE_RECURRING_DRAFTED activity', e);
        reportErrorToSentry(e);
      });

    return draftedExpense;
  }

  static async createFromExpense(expense: Expense, interval: RecurringExpenseIntervals, endsAt?: string | Date) {
    if (typeof endsAt === 'string') {
      endsAt = moment(endsAt).toDate();
    }

    const recurringExpense = await this.create({
      CollectiveId: expense.CollectiveId,
      FromCollectiveId: expense.FromCollectiveId,
      lastDraftedAt: new Date(),
      interval,
      endsAt,
    });
    await expense.update({ RecurringExpenseId: recurringExpense.id });
    return recurringExpense;
  }

  static async getRecurringExpensesDue() {
    const dateWhere = Object.values(RecurringExpenseIntervals).map(interval => ({
      lastDraftedAt: { [Op.lt]: moment().subtract(1, interval).endOf('day').toDate() },
      interval,
    }));
    return this.findAll({
      where: {
        [Op.or]: dateWhere,
        lastDraftedAt: { [Op.ne]: null },
        endsAt: { [Op.or]: [{ [Op.gt]: moment().startOf('day').toDate() }, { [Op.eq]: null }] },
      },
    });
  }
}

RecurringExpense.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    interval: {
      allowNull: false,
      type: DataTypes.ENUM(...Object.values(RecurringExpenseIntervals)),
    },
    lastDraftedAt: {
      type: DataTypes.DATE,
    },
    endsAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'RecurringExpenses',
  },
);

export default RecurringExpense;
