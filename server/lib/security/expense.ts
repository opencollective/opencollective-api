import type { Request } from 'express';
import { capitalize, compact, filter, find, first, flatten, max, startCase, uniq, uniqBy } from 'lodash';
import moment from 'moment';

import status from '../../constants/expense_status';
import expenseType from '../../constants/expense_type';
import models, { Op, sequelize } from '../../models';
import Expense from '../../models/Expense';
import { PayoutMethodTypes } from '../../models/PayoutMethod';

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
const setProperty = (obj, key) => value => {
  if (value) {
    obj[key] = value;
  }
};

type ExpenseStats = { count: number; lastCreatedAt: Date; status: status; CollectiveId: number };

const addBooleanCheck = (checks, condition: boolean, ifTrue: SecurityCheck, ifFalse?: SecurityCheck) =>
  condition ? checks.push(ifTrue) : ifFalse ? checks.push(ifFalse) : null;

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
      message: `${startCase(capitalize(scope))} was successfully paid ${
        paidInTheCollective?.count
      } times by this collective and ${paidOnThePlatform?.count} times on the platform`,
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

const getGroupedExpensesStats = <T extends { [key: string]: number }>(whereConditions: T[]) => {
  const group = uniq(whereConditions.map(where => Object.keys(where)[0]));
  return models.Expense.findAll({
    where: { [Op.or]: whereConditions, type: { [Op.ne]: expenseType.CHARGE } },
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
  }) as unknown as Promise<Array<ExpenseStats & T>>;
};

export const checkExpensesBatch = async (
  expenses: Array<Expense>,
  { loaders },
): Promise<Array<Array<SecurityCheck>>> => {
  const expensesStatsConditions = flatten(
    expenses.map(expense => {
      const fields: Array<{ [key: string]: number }> = [{ UserId: expense.UserId }];
      if (expense.User.CollectiveId !== expense.FromCollectiveId) {
        fields.push({ FromCollectiveId: expense.FromCollectiveId });
      }
      if (
        expense.PayoutMethod &&
        [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(expense.PayoutMethod?.type)
      ) {
        fields.push({ PayoutMethodId: expense.PayoutMethodId });
      }
      return fields;
    }),
  ) as Array<Record<'CollectiveId' | 'PayoutMethodId' | 'UserId', number>>;
  const stats = await getGroupedExpensesStats(expensesStatsConditions);
  const usersByIpConditions = expenses.map(expense => {
    const ip = expense.User.getLastKnownIp();
    return {
      [Op.or]: [
        // Same users that logged in around the time this expense was created
        { lastLoginAt: getTimeWindowFromDate(expense.createdAt, 3, 'days') },
        // Same users that logged in around the time this expense was updated
        { lastLoginAt: getTimeWindowFromDate(expense.updatedAt, 3, 'days') },
        // Same users that logged in around the same time the author
        { lastLoginAt: getTimeWindowFromDate(expense.User.lastLoginAt, 3, 'days') },
        // Same users created around the same period
        { createdAt: getTimeWindowFromDate(expense.User.createdAt, 3, 'days') },
      ],
      id: { [Op.ne]: expense.id },
      [Op.or]: [{ data: { creationRequest: { ip } } }, { data: { lastSignInRequest: { ip } } }],
    };
  });
  const usersByIp = await models.User.findAll({
    where: { [Op.or]: usersByIpConditions },
    include: [{ association: 'collective' }],
  });

  return await Promise.all(
    expenses.map(async expense => {
      const checks: SecurityCheck[] = [];

      expense.User &&
        !expense.User.collective &&
        (await loaders.Collective.byId.load(expense.User.CollectiveId).then(setProperty(expense.User, 'collective')));
      await expense.User.populateRoles();

      // Sock puppet detection: checks related users by correlating recently used IP address when logging in and creating new accounts.
      const relatedUsersByIp = uniqBy(
        filter(usersByIp, u => {
          const ip = expense.User.getLastKnownIp();
          return ip && (u.data?.creationRequest?.ip === ip || u.data?.lastSignInRequest?.ip === ip);
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
        await expense.User.hasTwoFactorAuthentication(),
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
      checkExpenseStats(filter(stats, { UserId: expense.UserId }), {
        expense,
        checks,
        scope: Scope.USER,
        details: `Expense submitted by ${expense.User.collective.name} (${expense.User.collective.slug})`,
      });
      // If the user sho submitted the expense is not the same being paid for the expense, run another statistical analysis of the payee.
      if (expense.User.CollectiveId !== expense.FromCollectiveId) {
        checkExpenseStats(filter(stats, { FromCollectiveId: expense.FromCollectiveId }), {
          expense,
          checks,
          scope: Scope.PAYEE,
          details: `Payee of the expense is ${expense.fromCollective.name} (${expense.fromCollective.slug})`,
        });
      }

      if (
        expense.PayoutMethod &&
        [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(expense.PayoutMethod?.type)
      ) {
        // Statistical analysis of the Payout Method
        checkExpenseStats(filter(stats, { PayoutMethodId: expense.PayoutMethodId }), {
          expense,
          checks,
          scope: Scope.PAYOUT_METHOD,
        });

        // Check if this Payout Method is being used by someone other user or collective
        const similarPayoutMethods = await expense.PayoutMethod.findSimilar({
          include: [models.Collective],
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
      }

      return checks;
    }),
  );
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
