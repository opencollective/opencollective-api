import DataLoader from 'dataloader';
import moment from 'moment';
import {
  BelongsToGetAssociationMixin,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
  Op,
  QueryTypes,
  Range,
  Transaction as SequelizeTransaction,
} from 'sequelize';
import Temporal from 'sequelize-temporal';

import ActivityTypes from '../constants/activities';
import { ENGINEERING_DOMAINS } from '../constants/engineering-domains';
import FEATURE from '../constants/feature';
import { PlatformSubscriptionPlan } from '../constants/plans';
import { sortResultsSimple } from '../graphql/loaders/helpers';
import { chargeExpense, getPreferredPlatformPayout } from '../lib/platform-subscriptions';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';
import models from '.';

export type Billing = {
  collectiveId: number;
  additional: {
    utilization: PeriodUtilization;
    amounts: PeriodUtilization;
    total: number;
  };
  base: {
    subscriptions: { title: string; amount: number; startDate: Date; endDate: Date }[];
    total: number;
  };
  totalAmount: number;
  billingPeriod: BillingPeriod;
  subscriptions: PlatformSubscription[];
  utilization: PeriodUtilization;
  dueDate: Date;
};

export enum BillingMonth {
  JANUARY = 0,
  FEBRUARY = 1,
  MARCH = 2,
  APRIL = 3,
  MAY = 4,
  JUNE = 5,
  JULY = 6,
  AUGUST = 7,
  SEPTEMBER = 8,
  OCTOBER = 9,
  NOVEMBER = 10,
  DECEMBER = 11,
}

export type BillingPeriod = {
  month: BillingMonth;
  year: number;
};

export enum UtilizationType {
  ACTIVE_COLLECTIVES = 'activeCollectives',
  EXPENSES_PAID = 'expensesPaid',
}

const UtilizationTypeToIncludedPlanKeyMap: Record<UtilizationType, keyof PlatformSubscriptionPlan['pricing']> = {
  [UtilizationType.ACTIVE_COLLECTIVES]: 'includedCollectives',
  [UtilizationType.EXPENSES_PAID]: 'includedExpensesPerMonth',
};

const UtilizationTypeToPricePlanKeyMap: Record<UtilizationType, keyof PlatformSubscriptionPlan['pricing']> = {
  [UtilizationType.ACTIVE_COLLECTIVES]: 'pricePerAdditionalCollective',
  [UtilizationType.EXPENSES_PAID]: 'pricePerAdditionalExpense',
};

type PeriodUtilization = Record<UtilizationType, number>;

class PlatformSubscription extends ModelWithPublicId<
  InferAttributes<PlatformSubscription>,
  InferCreationAttributes<PlatformSubscription>
> {
  public static readonly nanoIdPrefix = 'psub' as const;
  public static readonly tableName = 'PlatformSubscriptions' as const;

  declare id: number;
  declare public readonly publicId: string;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare plan: Partial<PlatformSubscriptionPlan>;
  declare period: Range<Date>;
  declare featureProvisioningStatus: 'PENDING' | 'PROVISIONED' | 'DEPROVISIONED';
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

  overlapWith(billingPeriod: BillingPeriod): [Date, Date] {
    const billingStart = PlatformSubscription.periodStartDate(
      PlatformSubscription.getBillingPeriodRange(billingPeriod),
    );
    const billingEnd = PlatformSubscription.periodEndDate(PlatformSubscription.getBillingPeriodRange(billingPeriod));

    let subBillingStart = billingStart;
    if (moment.utc(this.startDate).isAfter(billingStart)) {
      subBillingStart = this.startDate;
    }
    let subBillingEnd = billingEnd;
    if (moment.utc(this.endDate).isBefore(billingEnd)) {
      subBillingEnd = this.endDate;
    }

    return [subBillingStart, subBillingEnd];
  }

  prorateBasePrice(billingPeriod: BillingPeriod): number {
    const billingStart = PlatformSubscription.periodStartDate(
      PlatformSubscription.getBillingPeriodRange(billingPeriod),
    );
    const billingEnd = PlatformSubscription.periodEndDate(PlatformSubscription.getBillingPeriodRange(billingPeriod));

    const [subBillingStart, subBillingEnd] = this.overlapWith(billingPeriod);
    const billingTime = moment.utc(billingEnd).diff(billingStart, 'seconds');

    const subTime = moment.utc(subBillingEnd).diff(subBillingStart, 'seconds');

    const basePrice = this.plan.pricing?.pricePerMonth ?? 0;

    return Math.round(basePrice * (subTime / billingTime));
  }

  get info(): NonAttribute<
    Pick<PlatformSubscription, 'id' | 'plan' | 'period' | 'CollectiveId' | 'createdAt' | 'updatedAt'>
  > {
    return {
      id: this.id,
      plan: this.plan,
      period: this.period,
      CollectiveId: this.CollectiveId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
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

  static currentBillingPeriod(): BillingPeriod {
    return {
      year: moment.utc().year(),
      month: moment.utc().month(),
    };
  }

  static async calculateBilling(collectiveId: number, billingPeriod: BillingPeriod): Promise<Billing> {
    const utilization = await PlatformSubscription.calculateUtilization(collectiveId, billingPeriod);
    const subscriptions = await PlatformSubscription.getSubscriptionsInBillingPeriod(collectiveId, billingPeriod);
    const dueDate = moment
      .utc(new Date(Date.UTC(billingPeriod.year, billingPeriod.month)))
      .add(1, 'month')
      .startOf('month')
      .toDate();

    if (subscriptions.length === 0) {
      return {
        collectiveId,
        base: {
          total: 0,
          subscriptions: [],
        },
        additional: {
          utilization: Object.fromEntries(Object.entries(utilization).map(([k]) => [k, 0])) as PeriodUtilization,
          total: 0,
          amounts: Object.fromEntries(Object.entries(utilization).map(([k]) => [k, 0])) as PeriodUtilization,
        },
        totalAmount: 0,
        billingPeriod,
        subscriptions,
        utilization,
        dueDate,
      };
    }

    const lastActiveSubscription = subscriptions[0];
    const plan = lastActiveSubscription.plan;

    const additionalUtilization = Object.fromEntries(
      Object.keys(utilization).map(utilizationType => [
        utilizationType,
        Math.max(
          0,
          utilization[utilizationType] - (plan.pricing?.[UtilizationTypeToIncludedPlanKeyMap[utilizationType]] ?? 0),
        ),
      ]),
    ) as PeriodUtilization;

    const additionalUtilizationAmounts = Object.fromEntries(
      Object.entries(additionalUtilization).map(([utilizationType, additionalCount]) => [
        utilizationType,
        additionalCount * (plan.pricing?.[UtilizationTypeToPricePlanKeyMap[utilizationType]] ?? 0),
      ]),
    ) as PeriodUtilization;

    const additionalTotal = Object.entries(additionalUtilizationAmounts).reduce((acc, [, amount]) => acc + amount, 0);

    const subscriptionValues: Billing['base']['subscriptions'] = subscriptions.map(sub => {
      const [startDate, endDate] = sub.overlapWith(billingPeriod);
      return {
        title: sub.plan.title,
        startDate,
        endDate,
        amount: sub.prorateBasePrice(billingPeriod),
      };
    });
    const baseTotal = subscriptionValues.reduce((acc, sub) => acc + sub.amount, 0);

    const totalAmount = baseTotal + additionalTotal;

    return {
      collectiveId,
      base: {
        total: baseTotal,
        subscriptions: subscriptionValues,
      },
      additional: {
        utilization: additionalUtilization,
        amounts: additionalUtilizationAmounts,
        total: additionalTotal,
      },
      totalAmount: totalAmount,
      billingPeriod,
      subscriptions,
      utilization,
      dueDate,
    };
  }

  static rangeLiteral(range: Range<Date>): string {
    const Range = new DataTypes['postgres'].RANGE(DataTypes.DATE);
    return `${Range.stringify(range, {})}::tstzrange`;
  }

  static getBillingPeriodRange(billingPeriod: BillingPeriod): Range<Date> {
    const start = {
      inclusive: true,
      value: moment.utc(Date.UTC(billingPeriod.year, billingPeriod.month)).startOf('month').toDate(),
    };

    const end = {
      inclusive: true,
      value: moment.utc(Date.UTC(billingPeriod.year, billingPeriod.month)).endOf('month').toDate(),
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

  static async createSubscription(
    collective: Collective,
    start: Date,
    plan: Partial<PlatformSubscriptionPlan>,
    user: User,
    opts?: {
      transaction?: SequelizeTransaction;
      UserTokenId?: number;
      previousPlan?: Partial<PlatformSubscriptionPlan>;
      notify?: boolean;
    },
  ): Promise<PlatformSubscription> {
    const alignedStart = moment.utc(start).startOf('day').toDate();
    const notify = opts?.notify ?? true;

    const subscription = await PlatformSubscription.create(
      {
        CollectiveId: collective.id,
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

    // Emit activity if user is provided
    try {
      // Calculate next billing date (first day of next month)
      const nextBillingDate = moment.utc().add(1, 'month').startOf('month').toDate();

      await Activity.create(
        {
          type: ActivityTypes.PLATFORM_SUBSCRIPTION_UPDATED,
          UserId: user.id,
          CollectiveId: collective.id,
          UserTokenId: opts?.UserTokenId,
          data: {
            account: collective.info,
            user: user.info,
            previousPlan: opts?.previousPlan ?? null,
            newPlan: plan,
            nextBillingDate,
            notify,
          },
        },
        {
          transaction: opts?.transaction,
        },
      );
    } catch (error) {
      reportErrorToSentry(error);
    }

    return subscription;
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
    collective: Collective,
    when: Date,
    plan: Partial<PlatformSubscriptionPlan>,
    user: User,
    opts?: { transaction?: SequelizeTransaction; UserTokenId?: number },
  ): Promise<PlatformSubscription> {
    const currentSubscription = await PlatformSubscription.getCurrentSubscription(collective.id);
    const newSubscriptionStart = moment.utc(when).startOf('day');
    const previousPlan = currentSubscription?.plan;

    if (currentSubscription) {
      const currentSubscriptionStart = moment.utc(currentSubscription.startDate);
      if (currentSubscriptionStart.isSameOrAfter(newSubscriptionStart)) {
        await currentSubscription.destroy({ transaction: opts?.transaction });
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

    const newSubscription = await PlatformSubscription.createSubscription(
      collective,
      newSubscriptionStart.toDate(),
      plan,
      user,
      { ...opts, previousPlan },
    );

    // If the new subscription starts today, provision the features immediately. Otherwise,
    // they'll be provisioned in the "handle-plans-feature-provisioning" CRON job.
    if (newSubscriptionStart.isSame(moment.utc().startOf('day'))) {
      await PlatformSubscription.provisionFeatureChanges(collective, currentSubscription, newSubscription, {
        transaction: opts?.transaction,
      });
    }

    return newSubscription;
  }

  /**
   * A hook to call when changing plan, to handle the side-effects required to
   * enable/disable new features.
   */
  public static async provisionFeatureChanges(
    collective: Collective,
    previousSubscription: PlatformSubscription | null,
    newSubscription: PlatformSubscription | null,
    opts?: { transaction?: SequelizeTransaction },
  ): Promise<void> {
    if (previousSubscription) {
      const currentSubscriptionFeatures = previousSubscription.plan?.features || {};
      const newSubscriptionFeatures = newSubscription?.plan?.features || {};
      const removedFeatures = Object.keys(currentSubscriptionFeatures).filter(
        feature => currentSubscriptionFeatures[feature] && !newSubscriptionFeatures[feature],
      );

      for (const feature of removedFeatures) {
        if (feature === FEATURE.TAX_FORMS) {
          await models.RequiredLegalDocument.destroy({
            where: { HostCollectiveId: collective.id },
            transaction: opts?.transaction,
          });
        } else if (feature === FEATURE.OFF_PLATFORM_TRANSACTIONS) {
          const { failures } = await models.TransactionsImport.disconnectAll(collective, {
            transaction: opts?.transaction,
          });
          if (failures.length > 0) {
            reportErrorToSentry(
              new Error('Failed to disconnect transactions imports while provisioning feature changes'),
              { extra: { failures }, domain: ENGINEERING_DOMAINS.OFF_PLATFORM_TRANSACTIONS },
            );
          }
        } else if (feature === FEATURE.CHARGE_HOSTING_FEES) {
          await collective.updateHostFeeAsSystem(0, {
            transaction: opts?.transaction,
            dropCustomHostedCollectivesFees: true,
          });
        }
      }

      await previousSubscription.update(
        { featureProvisioningStatus: 'DEPROVISIONED' },
        { transaction: opts?.transaction },
      );
    }

    if (newSubscription) {
      // This function only looks at removed features for now. In the future, we
      // may want to hook here the side-effects required to enable new features
      // like creating a RequiredLegalDocument for tax forms, which we don't want
      // to do yet for security reasons: https://github.com/opencollective/opencollective/issues/8153.
      await newSubscription.update({ featureProvisioningStatus: 'PROVISIONED' }, { transaction: opts?.transaction });
    }
  }

  static getPreferredPlatformPayout = getPreferredPlatformPayout;

  static chargeExpense = chargeExpense;

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
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
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
    featureProvisioningStatus: {
      type: DataTypes.ENUM('PENDING', 'PROVISIONED', 'DEPROVISIONED'),
      allowNull: false,
      defaultValue: 'PENDING',
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
