import type { Request } from 'express';
import { capitalize, compact, filter, find, first, isEqual, isNil, keyBy, max, startCase, uniq, uniqBy } from 'lodash';
import moment from 'moment';

import status from '../../constants/expense-status';
import expenseType from '../../constants/expense-type';
import type { ConvertToCurrencyArgs } from '../../graphql/loaders/currency-exchange-rate';
import models, { Op, sequelize } from '../../models';
import Expense from '../../models/Expense';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import { RecipientAccount as BankAccountPayoutMethodData } from '../../types/transferwise';
import { expenseMightBeSubjectToTaxForm } from '../tax-forms';
import { formatCurrency } from '../utils';

export enum Scope {
  USER = 'USER',
  COLLECTIVE = 'COLLECTIVE',
  PAYEE = 'PAYEE',
  PAYOUT_METHOD = 'PAYOUT_METHOD',
}

export enum Level {
  PASS = 'PASS',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

type SecurityCheck = {
  scope: Scope;
  level: Level;
  message: string;
  details?: string;
};

const stringifyUser = user => (user.collective ? user.collective.slug : `#${user.id}`);
const stringifyUserList = users => compact(users.map(stringifyUser)).join(', ');
const isDefinedButNotEqual = (a, b) => !isNil(a) && !isNil(b) && !isEqual(a, b);

type ExpenseStats = { count: number; lastCreatedAt: Date; status: status; CollectiveId: number };

type ExpenseAmountStats = {
  amountInHostCurrency: number;
  totalApprovedAmountForCollective: number;
  totalApprovedCountForCollective: number;
  averageAmountForCollective: number;
  paidAmountP95ForCollective: number;
  isConvertedCurrency: boolean;
};

const addBooleanCheck = (
  checks: Array<SecurityCheck>,
  condition: boolean,
  ifTrue: SecurityCheck,
  ifFalse?: SecurityCheck,
) => (condition ? checks.push(ifTrue) : ifFalse ? checks.push(ifFalse) : null);

const getTimeWindowFromDate = (
  date: moment.MomentInput,
  amount: moment.DurationInputArg1,
  unit: moment.DurationInputArg2,
) => ({
  [Op.gte]: moment(date).subtract(amount, unit).toDate(),
  [Op.lte]: moment(date).add(amount, unit).toDate(),
});

type StatsAggregatedByStatus = Record<status, ExpenseStats>;
const aggregateByStatus = (stats: ExpenseStats[]) =>
  Object.values(
    stats.reduce((result = {} as StatsAggregatedByStatus, value: ExpenseStats): StatsAggregatedByStatus => {
      if (result[value.status]) {
        result[value.status].count += value.count;
        result[value.status].lastCreatedAt = max([value.lastCreatedAt, result[value.status].lastCreatedAt]);
      } else {
        result[value.status] = value;
      }
      return result;
    }, {} as StatsAggregatedByStatus),
  );

// Runs statistical analysis of past Expenses based on different conditionals
const checkExpenseStats = (
  stats,
  { expense, checks, scope, details }: { scope: Scope; details?: string; checks: Array<SecurityCheck>; expense },
) => {
  const platformStats = aggregateByStatus(stats);
  const collectiveStats = filter(stats, { CollectiveId: expense.CollectiveId });

  // Checks if there was any SPAM or rejects on the platform
  const spam = find(platformStats, { status: status.SPAM });
  addBooleanCheck(checks, Boolean(spam), {
    scope,
    level: Level.HIGH,
    message: `${startCase(capitalize(scope))} has expenses that were previously  marked as SPAM`,
    details,
  });
  const rejected = find(platformStats, { status: status.REJECTED });
  addBooleanCheck(checks, Boolean(rejected), {
    scope,
    level: Level.LOW,
    message: `${startCase(capitalize(scope))} has expenses that were previously rejected`,
    details,
  });

  const paidInTheCollective = find(collectiveStats, { status: status.PAID });
  const paidOnThePlatform = find(platformStats, { status: status.PAID });

  // Check if there was any past expense already paid in this collective
  if (paidInTheCollective) {
    addBooleanCheck(checks, paidInTheCollective.count > 0, {
      scope,
      level: Level.PASS,
      message: `${startCase(
        capitalize(scope),
      )} was successfully paid ${paidInTheCollective?.count} times by this collective and ${paidOnThePlatform?.count} times on the platform`,
      details,
    });
  }
  const wasNeverPaidOnThePlatform = !paidOnThePlatform;
  // Check if there was any past expense already paid on the platform
  addBooleanCheck(checks, !wasNeverPaidOnThePlatform && !paidInTheCollective, {
    scope,
    level: Level.LOW,
    message: `${startCase(
      capitalize(scope),
    )} has never been paid by this collective but was already paid on the platform`,
    details,
  });
  // Alerts that there was no expenses paid on the platform
  addBooleanCheck(checks, wasNeverPaidOnThePlatform, {
    scope,
    level: Level.HIGH,
    message: `${startCase(capitalize(scope))} has never been paid on the platform`,
    details,
  });
};

const checkExpenseAmountStats = (
  checks: Array<SecurityCheck>,
  expenseStats: ExpenseAmountStats,
  collectiveBalanceInDisplayCurrency: number,
  displayCurrency: string,
) => {
  // Add warning if total approved is above the balance of the collective
  addBooleanCheck(checks, expenseStats.totalApprovedAmountForCollective > collectiveBalanceInDisplayCurrency, {
    scope: Scope.COLLECTIVE,
    level: Level.MEDIUM,
    message: `The total amount of approved expenses is higher than the collective balance`,
    details: `There are ${
      expenseStats.totalApprovedCountForCollective
    } approved expenses for this collective for a total of ${formatCurrency(
      expenseStats.totalApprovedAmountForCollective,
      displayCurrency,
    )}, which is higher than the collective balance of ${formatCurrency(
      collectiveBalanceInDisplayCurrency,
      displayCurrency,
    )}.`,
  });

  // Unless it's the 1st expense, add a warning if amount is above p95 for this collective
  if (expenseStats.paidAmountP95ForCollective) {
    addBooleanCheck(checks, expenseStats.amountInHostCurrency >= expenseStats.paidAmountP95ForCollective, {
      scope: Scope.COLLECTIVE,
      level: Level.MEDIUM,
      message: `Amount is higher than usual`,
      details: `The amount of this expense (${formatCurrency(
        expenseStats.amountInHostCurrency,
        displayCurrency,
        2,
        expenseStats.isConvertedCurrency,
      )}) is in the top 5% of expenses for this collective. The average amount of paid expenses is ${formatCurrency(
        expenseStats.averageAmountForCollective,
        displayCurrency,
      )}, with the top 5% being above ${formatCurrency(expenseStats.paidAmountP95ForCollective, displayCurrency)}.`,
    });
  }
};

const getGroupedExpensesStats = (expenses: Array<Expense>) => {
  const expensesStatsConditions = [];
  expenses.forEach(expense => {
    expensesStatsConditions.push({ UserId: expense.UserId });
    if (expense.User.CollectiveId !== expense.FromCollectiveId) {
      expensesStatsConditions.push({ FromCollectiveId: expense.FromCollectiveId });
    }
    if (
      expense.PayoutMethod &&
      [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(expense.PayoutMethod.type)
    ) {
      expensesStatsConditions.push({ PayoutMethodId: expense.PayoutMethodId });
    }
  });

  const group = uniq(expensesStatsConditions.map(where => Object.keys(where)[0]));
  return models.Expense.findAll({
    where: { [Op.or]: expensesStatsConditions, type: { [Op.ne]: expenseType.CHARGE } },
    attributes: [
      'status',
      'CollectiveId',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('MAX', sequelize.col('createdAt')), 'lastCreatedAt'],
      ...group,
    ],
    group: ['status', 'CollectiveId', ...group],
    order: [['lastCreatedAt', 'desc']],
    raw: true,
  }) as unknown as Promise<Array<ExpenseStats>>;
};

/**
 * Get some stats about the collectives of the expenses. Returns an object with the expense id as key and the stats as value.
 */
const getExpensesAmountsStats = async (
  expenses: Array<Expense>,
  displayCurrency,
): Promise<Record<string, ExpenseAmountStats>> => {
  const collectiveIds = uniq(expenses.map(e => e.CollectiveId));
  const expenseIds = uniq(expenses.map(e => e.id));
  const result: Array<ExpenseAmountStats> = await sequelize.query(
    `
      WITH all_expenses AS (
        SELECT
          e.*,
          e.currency != :displayCurrency AS "isConvertedCurrency",
          CASE
            -- Simple case: expense is already in display currency
            WHEN e.currency = :displayCurrency THEN e.amount
            -- Convert expense to display currency
            ELSE e.amount * COALESCE((
                SELECT rate
                FROM "CurrencyExchangeRates" r
                WHERE r."from" = e.currency
                AND r."to" = :displayCurrency
                AND r."createdAt" <= e."createdAt"
                ORDER BY e."createdAt" DESC -- Most recent rate that is older than the expense
                LIMIT 1
              ), (
                -- Fix for old expenses where we didn't have an exchange rate stored yet: just use the oldest rate available
                SELECT rate
                FROM "CurrencyExchangeRates" r
                WHERE r."from" = e.currency
                AND r."to" = :displayCurrency
                ORDER BY e."createdAt" ASC -- Oldest rate
                LIMIT 1
            ))
            END AS "amountInHostCurrency"
        FROM "Expenses" e
        WHERE e."deletedAt" IS NULL
        AND e."CollectiveId" IN (:collectiveIds)
        ORDER BY e."createdAt" ASC
      ), expense_for_stats AS (
        SELECT * FROM all_expenses e WHERE e.status IN ('APPROVED', 'PAID')
      ), all_collective_stats AS (
        SELECT
          e."CollectiveId",
          AVG("amountInHostCurrency") FILTER (WHERE status = 'PAID') AS "averageAmountForCollective",
          SUM("amountInHostCurrency") FILTER (WHERE status = 'APPROVED') AS "totalApprovedAmountForCollective",
          COUNT("id") FILTER (WHERE status = 'APPROVED') AS "totalApprovedCountForCollective",
          (SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "amountInHostCurrency") FILTER (WHERE status = 'PAID')) AS "paidAmountP95ForCollective"
        FROM expense_for_stats e
        GROUP BY e."CollectiveId"
      ) SELECT
        e."id",
        e."isConvertedCurrency",
        e."amountInHostCurrency",
        e."CollectiveId",
        COALESCE(s."averageAmountForCollective", 0) AS "averageAmountForCollective",
        COALESCE(s."totalApprovedAmountForCollective", 0) AS "totalApprovedAmountForCollective",
        COALESCE(s."totalApprovedCountForCollective", 0) AS "totalApprovedCountForCollective",
        COALESCE(s."paidAmountP95ForCollective", 0) AS "paidAmountP95ForCollective"
      FROM all_expenses e
      LEFT JOIN all_collective_stats s ON s."CollectiveId" = e."CollectiveId"
      WHERE e.id IN (:expenseIds)
    `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: { displayCurrency, collectiveIds, expenseIds },
    },
  );

  return keyBy(result, 'id');
};

/**
 * The currency that needs to be used will depend on the context. Since, for now, we're only
 * displaying these warnings for fiscal hosts, the assumption is that the currency of the
 * host is the one that should be used; regardless of the other expenses in the batch.
 */
const getDisplayCurrency = async expenses => {
  const host = await expenses[0].collective.getHostCollective();
  return host?.currency || expenses[0].collective.currency;
};

const getCollectiveBalances = async (
  req: Request,
  expenses: Expense[],
  displayCurrency: string,
): Promise<Record<string, { currency: string; value: number }>> => {
  const collectiveIds = uniq(expenses.map(e => e.CollectiveId));
  const balanceLoader = req.loaders.Collective.balance.buildLoader({ withBlockedFunds: true }); // Use the same loader as https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L70 to make sure we don't hit the DB twice
  const collectiveBalances = await balanceLoader.loadMany(collectiveIds);
  const balancesInHostCurrency = await Promise.all(
    collectiveBalances.map(async balance => {
      if (balance.currency === displayCurrency) {
        return balance;
      } else {
        const convertParams: ConvertToCurrencyArgs = {
          amount: balance.value,
          fromCurrency: balance.currency,
          toCurrency: displayCurrency,
        };
        return {
          value: await req.loaders.CurrencyExchangeRate.convert.load(convertParams),
          currency: displayCurrency,
        };
      }
    }),
  );

  return keyBy(balancesInHostCurrency, 'CollectiveId');
};

export const checkExpensesBatch = async (
  req: Request,
  expenses: Array<Expense>,
): Promise<Array<Array<SecurityCheck>>> => {
  const displayCurrency = await getDisplayCurrency(expenses);
  const expensesStats = await getGroupedExpensesStats(expenses);
  const expensesAmountsStats = await getExpensesAmountsStats(expenses, displayCurrency);
  const collectiveBalances = await getCollectiveBalances(req, expenses, displayCurrency);
  const usersByIpConditions = expenses.map(expense => {
    const ip = expense.User.getLastKnownIp();
    const timeWindows = compact([
      // Same users that logged in around the time this expense was created
      { lastLoginAt: getTimeWindowFromDate(expense.createdAt, 3, 'days') },
      // Same users that logged in around the time this expense was updated
      expense.updatedAt !== expense.createdAt && { lastLoginAt: getTimeWindowFromDate(expense.updatedAt, 3, 'days') },
      // Same users that logged in around the same time the author
      expense.User.lastLoginAt && { lastLoginAt: getTimeWindowFromDate(expense.User.lastLoginAt, 3, 'days') },
      // Same users created around the same period
      { createdAt: getTimeWindowFromDate(expense.User.createdAt, 3, 'days') },
    ]);
    return {
      [Op.and]: [
        {
          [Op.or]: timeWindows,
        },
        { id: { [Op.ne]: expense.User.id } },
        { [Op.or]: [{ data: { creationRequest: { ip } } }, { data: { lastSignInRequest: { ip } } }] },
      ],
    };
  });
  const usersByIp = await models.User.findAll({
    where: { [Op.or]: usersByIpConditions },
    include: [{ association: 'collective' }],
  });
  const result = await Promise.all(
    expenses.map(async expense => {
      const checks: SecurityCheck[] = [];

      if (!expense.User.collective) {
        expense.User.collective = await req.loaders.Collective.byId.load(expense.User.CollectiveId);
      }
      await expense.User.populateRoles();

      // Sock puppet detection: checks related users by correlating recently used IP address when logging in and creating new accounts.
      const relatedUsersByIp = uniqBy(
        filter(usersByIp, u => {
          const ip = expense.User.getLastKnownIp();
          return (
            u.id !== expense.User.id &&
            ip &&
            (u.data?.creationRequest?.ip === ip || u.data?.lastSignInRequest?.ip === ip)
          );
        }),
        'id',
      );
      const relatedUsersByConnectedAccounts = await expense.User.findRelatedUsersByConnectedAccounts();
      const details = [];
      if (relatedUsersByIp.length > 0) {
        details.push(`${stringifyUserList([expense.User, ...relatedUsersByIp])} were all accessed from the same IP.`);
      }
      if (relatedUsersByConnectedAccounts.length > 0) {
        details.push(
          `${stringifyUserList([expense.User, ...relatedUsersByConnectedAccounts])} share connected account usernames.`,
        );
      }
      addBooleanCheck(checks, relatedUsersByIp.length > 0 || relatedUsersByConnectedAccounts.length > 0, {
        scope: Scope.USER,
        level: relatedUsersByConnectedAccounts.length ? Level.HIGH : Level.MEDIUM,
        message: `This user may be impersonating multiple profiles`,
        details: compact(details).join(' '),
      });

      // Author Security Check: Checks if the author of the expense has 2FA enabled or not.
      addBooleanCheck(
        checks,
        await req.loaders.userHasTwoFactorAuthEnabled.load(expense.User.id),
        {
          scope: Scope.USER,
          level: Level.PASS,
          message: 'User has 2FA enabled',
          details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
        },
        {
          scope: Scope.USER,
          level: Level.MEDIUM,
          message: 'User is not using 2FA',
          details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
        },
      );

      // Author Membership Check: Checks if the user is admin of the fiscal host or the collective paying for the expense
      const userIsHostAdmin = expense.User.isAdmin(expense.HostCollectiveId);
      addBooleanCheck(checks, userIsHostAdmin, {
        scope: Scope.USER,
        level: Level.PASS,
        message: 'User is the admin of this fiscal host',
        details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
      });
      addBooleanCheck(checks, !userIsHostAdmin && expense.User.isAdminOfCollective(expense.collective), {
        scope: Scope.USER,
        level: Level.LOW,
        message: `User is the admin of this collective`,
        details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
      });

      // Statistical analysis of the user who submitted the expense.
      checkExpenseStats(filter(expensesStats, { UserId: expense.UserId }), {
        expense,
        checks,
        scope: Scope.USER,
        details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
      });
      // If the user sho submitted the expense is not the same being paid for the expense, run another statistical analysis of the payee.
      if (expense.User.CollectiveId !== expense.FromCollectiveId) {
        checkExpenseStats(filter(expensesStats, { FromCollectiveId: expense.FromCollectiveId }), {
          expense,
          checks,
          scope: Scope.PAYEE,
          details: `Payee of the expense is ${expense.fromCollective.name} (${expense.fromCollective.slug})`,
        });
      }

      // Check amounts
      const balanceInHostCurrency = collectiveBalances[expense.CollectiveId]?.value || 0;
      checkExpenseAmountStats(checks, expensesAmountsStats[expense.id], balanceInHostCurrency, displayCurrency);

      const payoutMethod = expense.PayoutMethod;
      // Add checks on payout method
      if (payoutMethod && [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(payoutMethod?.type)) {
        // Statistical analysis of the Payout Method
        checkExpenseStats(filter(expensesStats, { PayoutMethodId: expense.PayoutMethodId }), {
          expense,
          checks,
          scope: Scope.PAYOUT_METHOD,
        });

        // Check if this Payout Method is being used by someone other user or collective
        const similarPayoutMethods = await expense.PayoutMethod.findSimilar({
          include: [{ model: models.Collective, attributes: ['slug'] }],
          where: { CollectiveId: { [Op.ne]: expense.User.collective.id } },
        });
        if (similarPayoutMethods) {
          addBooleanCheck(checks, similarPayoutMethods.length > 0, {
            scope: Scope.PAYOUT_METHOD,
            level: Level.HIGH,
            message: `Payout Method details is being used by other user or collectives`,
            details: `This same account information is being used by ${uniq(
              compact(similarPayoutMethods.map(pm => pm.Collective?.slug)),
            ).join(', ')}. This may be a sock puppet account.`,
          });
        }

        if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
          const pmAddress = (payoutMethod.data as BankAccountPayoutMethodData)?.details?.address;
          const payeeAddress = expense.payeeLocation?.structured || expense.fromCollective.data?.address;

          const pmCountry = pmAddress?.country;
          const payeeCountry = expense.payeeLocation?.country || expense.fromCollective.countryISO;
          const isDifferentCountry = isDefinedButNotEqual(pmCountry, payeeCountry);

          const pmCity = pmAddress?.city;
          const payeeCity = payeeAddress?.city;
          const isDifferentCity = isDefinedButNotEqual(pmCity, payeeCity);

          const pmCode = pmAddress?.postCode;
          const payeeCode = payeeAddress?.postalCode;
          const isDifferentCode = isDefinedButNotEqual(pmCode, payeeCode);

          addBooleanCheck(checks, isDifferentCountry || isDifferentCity || isDifferentCode, {
            scope: Scope.PAYOUT_METHOD,
            level: Level.MEDIUM,
            message: `Payout Method address is different from the payee's address`,
            details: `While the payee is registered at ${payeeCity}, ${payeeCountry} (${payeeCode}), the payout method used in this expense is located at ${pmCity}, ${pmCountry} (${pmCode})`,
          });
        }
      }

      // Add check for tax form
      if (expenseMightBeSubjectToTaxForm(expense)) {
        addBooleanCheck(checks, await req.loaders.Expense.taxFormRequiredBeforePayment.load(expense.id), {
          scope: Scope.PAYEE,
          level: Level.MEDIUM,
          message: `Pending required legal documents`,
          details: `Expense is pending a US tax form (W9/W8-BEN)`,
        });
      }

      const orderStats:
        | undefined
        | {
            errorRate1M: number;
            errorRate3M: number;
            errorRate12M: number;
            numOrders1M: number;
            numOrders3M: number;
            numOrders12M: number;
          } = await req.loaders.Collective.stats.orders.load(expense.CollectiveId);
      if (orderStats) {
        const checkVector = (stats, threshold) => stats.every((stat, index) => stat >= threshold[index]);
        // Current month error rate above 30% and more than 10 orders
        addBooleanCheck(checks, checkVector([orderStats.errorRate1M, orderStats.numOrders1M], [0.3, 10]), {
          scope: Scope.COLLECTIVE,
          level: Level.HIGH,
          message: `High order error rate in current month`,
          details: `The order error rate for this collective has been ${Math.round(
            orderStats.errorRate1M * 100,
          )}% over the current month, which is higher than the average of ${Math.round(
            orderStats.errorRate3M * 100,
          )}% over the past 3 months.`,
        });
        // Current month error rate above 20% and increasing by 40% compared to the previous 3 month period and more than 20 orders in the past 3 months
        addBooleanCheck(
          checks,
          checkVector(
            [orderStats.errorRate1M, orderStats.errorRate1M / (orderStats.errorRate3M || 1), orderStats.numOrders3M],
            [0.2, 1.4, 20],
          ),
          {
            scope: Scope.COLLECTIVE,
            level: Level.HIGH,
            message: `Recent increase in order error rate`,
            details: `The order error rate for this collective has been ${Math.round(
              orderStats.errorRate1M * 100,
            )}% over the current month, which is higher than the average of ${Math.round(
              orderStats.errorRate3M * 100,
            )}% over the past 3 months.`,
          },
        );
        // 3 month error rate above 30% and yearly error rate above 20%
        addBooleanCheck(checks, checkVector([orderStats.errorRate3M, orderStats.errorRate12M], [0.3, 0.2]), {
          scope: Scope.COLLECTIVE,
          level: Level.MEDIUM,
          message: `Collective has a consistently high order error rate`,
          details: `The order error rate for this collective has been ${Math.round(
            orderStats.errorRate3M * 100,
          )}% over the past 3 months, which is higher than the average of ${Math.round(
            orderStats.errorRate12M * 100,
          )}% over the past 12 months.`,
        });
      }

      return checks;
    }),
  );
  return result;
};

export const checkExpense = async (expense: Expense, { req }: { req?: Request } = {}): Promise<SecurityCheck[]> => {
  await expense.reload({
    include: [
      { association: 'collective' },
      { association: 'fromCollective' },
      { model: models.User, include: [{ association: 'collective' }] },
      { model: models.PayoutMethod },
    ],
  });
  return checkExpensesBatch(req, [expense]).then(first);
};
