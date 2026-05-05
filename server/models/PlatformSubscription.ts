import DataLoader from 'dataloader';
import { keyBy } from 'lodash';
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

import ActivityTypes from '../constants/activities';
import { ENGINEERING_DOMAINS } from '../constants/engineering-domains';
import FEATURE from '../constants/feature';
import { PlatformSubscriptionPlan, PlatformSubscriptionTiers, PlatformSubscriptionTierTypes } from '../constants/plans';
import { sortResultsSimple } from '../graphql/loaders/helpers';
import { roundCentsAmount } from '../lib/currency';
import { chargeExpense, getPreferredPlatformPayout } from '../lib/platform-subscriptions';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
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

export type PeriodUtilization = Record<UtilizationType, number>;

export type PlatformPlanSuggestion = {
  plan: PlatformSubscriptionPlan;
  estimatedPricePerMonth: number;
};

/** Catalog tier or merged plan JSON with at least `pricing` (see `PlatformSubscriptionTiers`). */
export type PlanPricingLike = { pricing?: PlatformSubscriptionPlan['pricing'] };

/**
 * Full-month estimated price for a catalog tier at the given utilization (same rule as billing overages).
 */
export function estimateMonthlyPriceForPlan(plan: PlanPricingLike, utilization: PeriodUtilization): number {
  const pricing = plan.pricing;
  const additionalCollectives = Math.max(
    0,
    utilization[UtilizationType.ACTIVE_COLLECTIVES] - (pricing?.includedCollectives ?? 0),
  );
  const additionalExpenses = Math.max(
    0,
    utilization[UtilizationType.EXPENSES_PAID] - (pricing?.includedExpensesPerMonth ?? 0),
  );
  return (
    (pricing?.pricePerMonth ?? 0) +
    additionalCollectives * (pricing?.pricePerAdditionalCollective ?? 0) +
    additionalExpenses * (pricing?.pricePerAdditionalExpense ?? 0)
  );
}

/**
 * Returns every catalog tier whose estimated monthly price is minimal for this utilization (handles ties).
 */
export function getCostOptimalPlatformTiersForUtilization(utilization: PeriodUtilization): PlatformPlanSuggestion[] {
  const scored = PlatformSubscriptionTiers.map(plan => ({
    plan: { ...plan, basePlanId: plan.id } as PlatformSubscriptionPlan,
    estimatedPricePerMonth: estimateMonthlyPriceForPlan(plan, utilization),
  }));
  const minPrice = Math.min(...scored.map(s => s.estimatedPricePerMonth));
  return scored.filter(s => s.estimatedPricePerMonth === minPrice);
}

/**
 * True if `next` is a downgrade relative to `prev`.
 */
export function getPlanChangeType(
  prev: Partial<Pick<PlatformSubscriptionPlan, 'type' | 'basePlanId' | 'id'>>,
  next: Partial<Pick<PlatformSubscriptionPlan, 'type' | 'basePlanId' | 'id'>>,
): 'DOWNGRADE' | 'UPGRADE' | 'CUSTOM' | 'NO_CHANGE' {
  // Try with the plan type first (Free/Basic/Pro)
  const PLAN_TYPE_ORDER: Record<PlatformSubscriptionTierTypes, number> = { Discover: 0, Basic: 1, Pro: 2 };
  const typePrev = PLAN_TYPE_ORDER[prev.type];
  const typeNext = PLAN_TYPE_ORDER[next.type];
  if (typePrev !== undefined && typeNext !== undefined && typePrev !== typeNext) {
    return typeNext < typePrev ? 'DOWNGRADE' : 'UPGRADE';
  }

  // Otherwise, use the rank in the plans list (based on plan ID)
  const getTierKey = plan => plan.basePlanId ?? plan.id;
  const indexPrev = PlatformSubscriptionTiers.findIndex(t => t.id === getTierKey(prev));
  const indexNext = PlatformSubscriptionTiers.findIndex(t => t.id === getTierKey(next));
  if (indexPrev !== -1 && indexNext !== -1) {
    return indexPrev === indexNext ? 'NO_CHANGE' : indexNext < indexPrev ? 'DOWNGRADE' : 'UPGRADE';
  }

  // Can't tell for sure as at least one of the plans is custom
  return 'CUSTOM';
}

type EffectiveBillingEntry = { sub: PlatformSubscription; effectiveStart: Date };

/**
 * Given a list of subscriptions active during a billing period (sorted newest first),
 * consolidates them by absorbing any subscription whose tier was downgraded into the lower tier.
 *
 * This ensures that when a customer downgrades mid-period, the lower rate applies for
 * the entire prior portion, not just from the downgrade date forward. It also handles
 * chains (e.g. Basic→Pro→Discover results in a single Discover entry covering everything).
 *
 * Also consolidates same-level subscriptions (e.g. Basic→Basic) into a single entry.
 */
export function consolidateSubscriptionsForBillingPeriod(
  subscriptions: PlatformSubscription[],
  billingPeriod: BillingPeriod,
): EffectiveBillingEntry[] {
  return subscriptions.reduce<EffectiveBillingEntry[]>((result, olderSubscription) => {
    const [subStart] = olderSubscription.overlapWith(billingPeriod);

    if (result.length > 0) {
      const newerSubscription = result[result.length - 1].sub; // Subscriptions are ordered newest first
      const changeType = getPlanChangeType(olderSubscription.plan, newerSubscription.plan);
      if (['DOWNGRADE', 'NO_CHANGE'].includes(changeType)) {
        result[result.length - 1].effectiveStart = subStart;
        return result;
      }
    }

    return [...result, { sub: olderSubscription, effectiveStart: subStart }];
  }, []);
}

class PlatformSubscription extends Model<
  InferAttributes<PlatformSubscription>,
  InferCreationAttributes<PlatformSubscription>
> {
  public static readonly tableName = 'PlatformSubscriptions' as const;

  declare id: number;
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

  terminate({
    date = moment.utc().toDate(),
    transaction = undefined,
    inclusive = false,
  }: {
    date?: Date;
    inclusive?: boolean;
    transaction?: SequelizeTransaction;
  }): Promise<PlatformSubscription> {
    return this.update({ period: [this.start, { value: date, inclusive }] }, { transaction });
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
      AND COALESCE(c."ParentCollectiveId", c.id) != :HostCollectiveId
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

  /**
   * Same metrics as {@link calculateUtilization}, but for many host collectives in two SQL round-trips.
   */
  static async calculateUtilizationForCollectives(
    collectiveIds: number[],
    billingPeriod: BillingPeriod,
  ): Promise<Map<number, PeriodUtilization>> {
    const result = new Map<number, PeriodUtilization>();
    const uniqueIds = [...new Set(collectiveIds)];
    if (uniqueIds.length === 0) {
      return result;
    }

    for (const id of uniqueIds) {
      result.set(id, { activeCollectives: 0, expensesPaid: 0 });
    }

    const billingRange = PlatformSubscription.getBillingPeriodRange(billingPeriod);
    const billingRangeArg = PlatformSubscription.rangeLiteral(billingRange);

    const activeRows = await sequelize.query<{ HostCollectiveId: number; activeCollectives: number }>(
      `
      SELECT t."HostCollectiveId", COUNT(DISTINCT(COALESCE(c."ParentCollectiveId", c.id)))::int AS "activeCollectives"
      FROM "Transactions" t
      JOIN "Collectives" c ON c.id = t."CollectiveId"
      WHERE t."HostCollectiveId" IN (:collectiveIds)
      AND t."createdAt" <@ ${billingRangeArg}
      AND t."deletedAt" IS NULL
      GROUP BY t."HostCollectiveId"
      `,
      { type: QueryTypes.SELECT, replacements: { collectiveIds: uniqueIds } },
    );

    const expenseRows = await sequelize.query<{ HostCollectiveId: number; expensesPaid: number }>(
      `
      SELECT a."HostCollectiveId", COUNT(DISTINCT a."ExpenseId")::int AS "expensesPaid"
      FROM "Activities" a
      LEFT JOIN LATERAL (
        SELECT count(1) > 0 AS "previouslyPaid"
        FROM "Activities" hist
        WHERE hist."HostCollectiveId" = a."HostCollectiveId"
        AND hist."ExpenseId" = a."ExpenseId"
        AND hist."type" = 'collective.expense.paid'
        AND tstzrange(NULL, hist."createdAt", '[]') << ${billingRangeArg}
        LIMIT 1
      ) AS hist ON TRUE
      WHERE a."HostCollectiveId" IN (:collectiveIds)
      AND a."type" = 'collective.expense.paid'
      AND a."createdAt" <@ ${billingRangeArg}
      AND NOT hist."previouslyPaid"
      GROUP BY a."HostCollectiveId"
      `,
      { type: QueryTypes.SELECT, replacements: { collectiveIds: uniqueIds } },
    );

    for (const row of activeRows) {
      const u = result.get(row.HostCollectiveId);
      if (u) {
        u.activeCollectives = Number(row.activeCollectives);
      }
    }
    for (const row of expenseRows) {
      const u = result.get(row.HostCollectiveId);
      if (u) {
        u.expensesPaid = Number(row.expensesPaid);
      }
    }

    return result;
  }

  /**
   * For each host collective id, returns every catalog tier with minimal estimated monthly cost for the period.
   */
  static async suggestPlans(
    collectiveIds: number[],
    billingPeriod: BillingPeriod,
  ): Promise<Map<number, PlatformPlanSuggestion[]>> {
    const out = new Map<number, PlatformPlanSuggestion[]>();
    if (collectiveIds.length === 0) {
      return out;
    }

    const utilizationById = await PlatformSubscription.calculateUtilizationForCollectives(collectiveIds, billingPeriod);
    const zero: PeriodUtilization = { activeCollectives: 0, expensesPaid: 0 };

    for (const id of collectiveIds) {
      const utilization = utilizationById.get(id) ?? zero;
      out.set(id, getCostOptimalPlatformTiersForUtilization(utilization));
    }

    return out;
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

    // Consolidate subscriptions so that any mid-period downgrade causes the cheaper plan to
    // cover the higher-tier plan's portion too (no pro-rata charge for the higher tier).
    const effectiveBillingEntries = consolidateSubscriptionsForBillingPeriod(subscriptions, billingPeriod);

    // Pro-rate the base price for each effective subscription, using potentially extended start dates
    const billingPeriodRange = PlatformSubscription.getBillingPeriodRange(billingPeriod);
    const billingPeriodStart = PlatformSubscription.periodStartDate(billingPeriodRange);
    const billingPeriodEnd = PlatformSubscription.periodEndDate(billingPeriodRange);
    const totalBillingSeconds = moment.utc(billingPeriodEnd).diff(billingPeriodStart, 'seconds');

    const subscriptionValues: Billing['base']['subscriptions'] = effectiveBillingEntries.map(
      ({ sub, effectiveStart }) => {
        const [, subBillingEnd] = sub.overlapWith(billingPeriod);
        const subSeconds = moment.utc(subBillingEnd).diff(effectiveStart, 'seconds');
        const basePrice = sub.plan.pricing?.pricePerMonth ?? 0;
        return {
          title: sub.plan.title,
          startDate: effectiveStart,
          endDate: subBillingEnd,
          amount: roundCentsAmount(basePrice * (subSeconds / totalBillingSeconds), 'USD'),
        };
      },
    );
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
    user: User | null,
    opts?: {
      transaction?: SequelizeTransaction;
      UserTokenId?: number;
      previousPlan?: Partial<PlatformSubscriptionPlan>;
      notify?: boolean;
      isAutomaticMigration?: boolean;
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
          UserId: user?.id,
          CollectiveId: collective.id,
          UserTokenId: opts?.UserTokenId,
          data: {
            account: collective.info,
            user: user?.info,
            previousPlan: opts?.previousPlan ?? null,
            newPlan: plan,
            nextBillingDate,
            notify,
            startDate: alignedStart,
            isAutomaticMigration: opts?.isAutomaticMigration ?? false,
            awaitForDispatch: true, // Ensure the email is sent
            isSystem: !user,
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
    opts?: { now?: () => Date; transaction?: SequelizeTransaction },
  ): Promise<PlatformSubscription | null> {
    const newDate = opts?.now ?? (() => new Date());
    return PlatformSubscription.findOne({
      where: {
        CollectiveId: collectiveId,
        period: {
          [Op.contains]: newDate(),
        },
      },
      transaction: opts?.transaction,
    });
  }

  static async replaceCurrentSubscription(
    collective: Collective,
    when: Date,
    plan: Partial<PlatformSubscriptionPlan>,
    user: User | null,
    opts?: { transaction?: SequelizeTransaction; UserTokenId?: number; isAutomaticMigration?: boolean },
  ): Promise<PlatformSubscription> {
    const currentSubscription = await PlatformSubscription.getCurrentSubscription(collective.id);
    const newSubscriptionStart = moment.utc(when).startOf('day');
    const previousPlan = currentSubscription?.plan;

    if (currentSubscription) {
      const currentSubscriptionStart = moment.utc(currentSubscription.startDate);
      if (currentSubscriptionStart.isSameOrAfter(newSubscriptionStart)) {
        await currentSubscription.destroy({ transaction: opts?.transaction });
      } else {
        await currentSubscription.terminate({
          date: newSubscriptionStart.toDate(),
          transaction: opts?.transaction,
          inclusive: false,
        });
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
      hasPlatformTips: new DataLoader<number, boolean | undefined>(async collectiveIds => {
        const rows = (await PlatformSubscription.findAll({
          raw: true,
          mapToModel: false,
          attributes: [
            'CollectiveId',
            [sequelize.literal(`("plan"->'pricing'->>'platformTips')::boolean`), 'hasPlatformTips'],
          ],
          where: {
            CollectiveId: collectiveIds,
            period: {
              [Op.contains]: new Date(),
            },
          },
        })) as unknown as { CollectiveId: number; hasPlatformTips: boolean | null }[];

        const grouped = keyBy(rows, 'CollectiveId');
        return collectiveIds.map(id => (grouped[id] ? grouped[id].hasPlatformTips : undefined));
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
