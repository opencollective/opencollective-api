import DataLoader from 'dataloader';
import moment from 'moment';
import {
  BelongsToGetAssociationMixin,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Op,
  QueryTypes,
  Range,
  Transaction as SequelizeTransaction,
} from 'sequelize';
import Temporal from 'sequelize-temporal';

import { PlatformSubscriptionPlan } from '../constants/plans';
import { sortResultsSimple } from '../graphql/loaders/helpers';
import sequelize from '../lib/sequelize';

import Collective from './Collective';

export enum BillingMonth {
  JANUARY = 1,
  FEBRUARY = 2,
  MARCH = 3,
  APRIL = 4,
  MAY = 5,
  JUNE = 6,
  JULY = 7,
  AUGUST = 8,
  SEPTEMBER = 9,
  OCTOBER = 10,
  NOVEMBER = 11,
  DECEMBER = 12,
}

export type BillingPeriod = {
  month: BillingMonth;
  year: number;
};

export enum UtilizationType {
  ACTIVE_COLLECTIVES = 'activeCollectives',
  EXPENSES_PAID = 'expensesPaid',
}

type PeriodUtilization = Record<UtilizationType, number>;

class PlatformSubscription extends Model<
  InferAttributes<PlatformSubscription>,
  InferCreationAttributes<PlatformSubscription>
> {
  declare id: number;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare plan: Partial<PlatformSubscriptionPlan>;
  declare period: Range<Date>;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare deletedAt?: Date;

  declare collective?: NonAttribute<Collective>;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;

  get start(): NonAttribute<Range<Date>[0]> {
    return this.period[0];
  }

  get end(): NonAttribute<Range<Date>[1]> {
    return this.period[1];
  }

  /**
   * Returns start date (inclusive)
   */
  get startDate(): NonAttribute<Date> {
    return PlatformSubscription.periodStartDate(this.period);
  }

  /**
   * Returns end date (inclusive) if set
   */
  get endDate(): NonAttribute<Date | null> {
    return PlatformSubscription.periodEndDate(this.period);
  }

  get isCurrent(): NonAttribute<boolean> {
    if (this.endDate === null) {
      return true;
    }

    const now = moment.utc();
    return now.isSameOrBefore(this.endDate) && now.isSameOrAfter(this.startDate);
  }

  static async calculateUtilization(collectiveId: number, billingPeriod: BillingPeriod): Promise<PeriodUtilization> {
    const billingRange = PlatformSubscription.getBillingPeriodRange(billingPeriod);
    const billingRangeArg = PlatformSubscription.rangeLiteral(billingRange);

    const { activeCollectives }: { activeCollectives: number } = await sequelize.query(
      `
      SELECT COUNT(DISTINCT(COALESCE(c."ParentCollectiveId", c.id))) "activeCollectives"
      FROM "Transactions" t
      JOIN "Collectives" c on c.id = t."CollectiveId"
      WHERE
      t."HostCollectiveId" = :HostCollectiveId
      AND t."createdAt" <@ ${billingRangeArg}
      AND t."deletedAt" IS NULL
    `,
      {
        type: QueryTypes.SELECT,
        raw: true,
        plain: true,
        replacements: {
          HostCollectiveId: collectiveId,
        },
      },
    );

    const { expensesPaid }: { expensesPaid: number } = await sequelize.query(
      `
      SELECT COUNT(DISTINCT(a."ExpenseId")) "expensesPaid"
        FROM "Activities" a
        LEFT JOIN LATERAL (
          SELECT count(1) > 0 "previouslyPaid"
          FROM "Activities" "hist"
          WHERE hist."HostCollectiveId" = :HostCollectiveId
          AND hist."ExpenseId" = a."ExpenseId"
          AND hist."type" = 'collective.expense.paid'
          AND tstzrange(NULL, hist."createdAt", '[]') << ${billingRangeArg}
          LIMIT 1
        ) as "hist" ON TRUE
        WHERE a."HostCollectiveId" = :HostCollectiveId
        AND a."type" = 'collective.expense.paid'
        AND a."createdAt" <@ ${billingRangeArg}
        AND NOT "hist"."previouslyPaid"
    `,
      {
        type: QueryTypes.SELECT,
        raw: true,
        plain: true,
        replacements: {
          HostCollectiveId: collectiveId,
        },
      },
    );

    return {
      activeCollectives,
      expensesPaid,
    };
  }

  static rangeLiteral(range: Range<Date>): string {
    const Range = new DataTypes['postgres'].RANGE(DataTypes.DATE);
    return `${Range.stringify(range, {})}::tstzrange`;
  }

  static getBillingPeriodRange(billingPeriod: BillingPeriod): Range<Date> {
    const start = {
      inclusive: true,
      value: moment
        .utc(Date.UTC(billingPeriod.year, billingPeriod.month - 1))
        .startOf('month')
        .toDate(),
    };

    const end = {
      inclusive: true,
      value: moment
        .utc(Date.UTC(billingPeriod.year, billingPeriod.month - 1))
        .endOf('month')
        .toDate(),
    };

    return [start, end];
  }

  static periodStartDate(period: Range<Date>): Date {
    const start = period[0];
    if (start.value === -Infinity || start.value === null) {
      return new Date(0);
    }

    if (start.inclusive) {
      return new Date(start.value);
    }

    if (typeof start.value === 'number') {
      return new Date(start.value + 1);
    }

    return new Date(start.value.getTime() + 1);
  }

  static periodEndDate(period: Range<Date>): Date | null {
    const end = period[1];
    if (end.value === Infinity || end.value === null) {
      return null;
    }

    if (end.inclusive) {
      return new Date(end.value);
    }

    if (typeof end.value === 'number') {
      return new Date(end.value - 1);
    }

    return new Date(end.value.getTime() - 1);
  }

  static getSubscriptionsInBillingPeriod(
    collectiveId: number,
    billingPeriod: BillingPeriod,
  ): Promise<PlatformSubscription[]> {
    return PlatformSubscription.findAll({
      where: {
        CollectiveId: collectiveId,
        period: {
          [Op.overlap]: PlatformSubscription.getBillingPeriodRange(billingPeriod),
        },
      },
      order: [[sequelize.literal('lower(period)'), 'desc']],
    });
  }

  static createSubscription(
    collectiveId: number,
    start: Date,
    plan: Partial<PlatformSubscriptionPlan>,
    opts?: { transaction?: SequelizeTransaction },
  ): Promise<PlatformSubscription> {
    const alignedStart = moment.utc(start).startOf('day').toDate();

    return PlatformSubscription.create(
      {
        CollectiveId: collectiveId,
        period: [
          {
            value: alignedStart,
            inclusive: true,
          },
          {
            value: Infinity,
            inclusive: true,
          },
        ],
        plan,
      },
      {
        transaction: opts?.transaction,
      },
    );
  }

  static getCurrentSubscription(
    collectiveId: number,
    opts?: { now?: () => Date },
  ): Promise<PlatformSubscription | null> {
    const newDate = opts?.now ?? (() => new Date());
    return PlatformSubscription.findOne({
      where: {
        CollectiveId: collectiveId,
        period: {
          [Op.contains]: newDate(),
        },
      },
    });
  }

  static async replaceCurrentSubscription(
    collectiveId: number,
    when: Date,
    plan: Partial<PlatformSubscriptionPlan>,
    opts?: { transaction?: SequelizeTransaction },
  ): Promise<PlatformSubscription> {
    const currentSubscription = await PlatformSubscription.getCurrentSubscription(collectiveId);
    const newSubscriptionStart = moment.utc(when).startOf('day');

    if (currentSubscription) {
      const currentSubscriptionStart = moment.utc(currentSubscription.startDate);
      if (currentSubscriptionStart.isSameOrAfter(newSubscriptionStart)) {
        await currentSubscription.destroy();
      } else {
        await currentSubscription.update(
          {
            period: [
              currentSubscription.start,
              {
                value: newSubscriptionStart.toDate(),
                inclusive: false,
              },
            ],
          },
          {
            transaction: opts?.transaction,
          },
        );
      }
    }
    await currentSubscription.reload({ paranoid: false });

    return PlatformSubscription.createSubscription(collectiveId, newSubscriptionStart.toDate(), plan, opts);
  }

  static get loaders() {
    return {
      currentByCollectiveId: new DataLoader<number, PlatformSubscription>(async collectiveIds => {
        const rows = await PlatformSubscription.findAll({
          where: {
            CollectiveId: collectiveIds,
            period: {
              [Op.contains]: new Date(),
            },
          },
        });

        return sortResultsSimple(collectiveIds, rows, result => result.CollectiveId);
      }),
    };
  }
}

PlatformSubscription.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: false,
    },
    plan: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: sequelize.literal(`'{}'`),
    },
    period: {
      type: DataTypes.RANGE(DataTypes.DATE),
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
  },
  {
    sequelize,
    tableName: 'PlatformSubscriptions',
    paranoid: true,
  },
);

Temporal(PlatformSubscription, sequelize);

export default PlatformSubscription;
