import { capitalize, compact, find, mapValues, round, startCase } from 'lodash';

import status from '../../constants/expense_status';
import models, { sequelize } from '../../models';
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

const roundProps = keys => obj => mapValues(obj, (value, key) => (keys.includes(key) ? round(value, 2) : value));

const getExpensesStats = where =>
  models.Expense.findAll({
    where,
    attributes: [
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('MAX', sequelize.col('createdAt')), 'lastCreatedAt'],
    ],
    group: ['status'],
    order: [['lastCreatedAt', 'desc']],
    raw: true,
  }).then(results => results.map(roundProps(['amount_avg', 'amount_stddev'])));

export const checkExpense = async (expense: typeof models.Expense): Promise<SecurityCheck[]> => {
  const checks: SecurityCheck[] = [];
  const addBooleanCheck = (condition: boolean, ifTrue: SecurityCheck, ifFalse?: SecurityCheck) =>
    condition ? checks.push(ifTrue) : ifFalse ? checks.push(ifFalse) : null;

  await expense.reload({
    include: [
      { association: 'collective' },
      { association: 'fromCollective' },
      { model: models.User, include: [{ association: 'collective' }] },
      { model: models.PayoutMethod },
    ],
  });
  await expense.User.populateRoles();

  // Author
  addBooleanCheck(
    expense.User.hasTwoFactorAuthentication,
    {
      scope: Scope.USER,
      level: Level.PASS,
      message: 'User has 2FA enabled',
      details: `Expense submitted by ${expense.User.collective.name} (${expense.User.email})`,
    },
    {
      scope: Scope.USER,
      level: Level.MEDIUM,
      message: 'User is not using 2FA',
      details: `Expense submitted by ${expense.User.collective.name} (${expense.User.email})`,
    },
  );
  const userIsHostAdmin = expense.User.isAdmin(expense.HostCollectiveId);
  addBooleanCheck(userIsHostAdmin, {
    scope: Scope.USER,
    level: Level.PASS,
    message: 'User is the admin of this fiscal host',
    details: `Expense submitted by ${expense.User.collective.name} (${expense.User.email})`,
  });
  addBooleanCheck(!userIsHostAdmin && expense.User.isAdminOfCollective(expense.collective), {
    scope: Scope.USER,
    level: Level.LOW,
    message: `User is the admin of this collective`,
    details: `Expense submitted by ${expense.User.collective.name} (${expense.User.email})`,
  });

  const checkStats = async (where, { scope, details }: { scope: Scope; details?: string }) => {
    const platformStats = await getExpensesStats(where);
    const collectiveStats = await getExpensesStats({
      ...where,
      CollectiveId: expense.CollectiveId,
      currency: expense.currency,
    });

    const spam = find(platformStats, { status: status.SPAM });
    addBooleanCheck(spam, {
      scope,
      level: Level.HIGH,
      message: `${startCase(capitalize(scope))} has expenses that were previously  marked as SPAM`,
      details,
    });
    const rejected = find(platformStats, { status: status.SPAM });
    addBooleanCheck(rejected, {
      scope,
      level: Level.LOW,
      message: `${startCase(capitalize(scope))} has expenses that were previously rejected`,
      details,
    });

    const paidInTheCollective = find(collectiveStats, { status: status.PAID });
    const paidOnThePlatform = find(platformStats, { status: status.PAID });
    if (paidInTheCollective) {
      addBooleanCheck(paidInTheCollective.count > 0, {
        scope,
        level: Level.PASS,
        message: `${startCase(capitalize(scope))} was successfully paid ${
          paidInTheCollective.count
        } times by this collective and ${paidOnThePlatform.count} times on the platform`,
        details,
      });
    }
    const wasNeverPaidOnThePlatform = !paidOnThePlatform;
    addBooleanCheck(!wasNeverPaidOnThePlatform && !paidInTheCollective, {
      scope,
      level: Level.LOW,
      message: `${startCase(
        capitalize(scope),
      )} was never been paid by this collective but was already paid on the platform`,
      details,
    });
    addBooleanCheck(wasNeverPaidOnThePlatform, {
      scope,
      level: Level.HIGH,
      message: `${startCase(capitalize(scope))} was never been paid on the platform`,
      details,
    });
  };

  await checkStats(
    { UserId: expense.UserId },
    { scope: Scope.USER, details: `Expense submitted by ${expense.User.collective.name} (${expense.User.email})` },
  );
  if (expense.User.CollectiveId !== expense.FromCollectiveId) {
    await checkStats(
      { FromCollectiveId: expense.FromCollectiveId },
      {
        scope: Scope.PAYEE,
        details: `Payee of the expense is ${expense.fromCollective.name} (${expense.fromCollective.slug})`,
      },
    );
  }

  // Payout Method
  if (
    expense.PayoutMethod &&
    [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(expense.PayoutMethod?.type)
  ) {
    await checkStats({ PayoutMethodId: expense.PayoutMethodId }, { scope: Scope.PAYOUT_METHOD });
    const similarPayoutMethods = await expense.PayoutMethod.findSimilar({ include: [models.Collective] });
    if (similarPayoutMethods) {
      addBooleanCheck(similarPayoutMethods.length > 3, {
        scope: Scope.PAYOUT_METHOD,
        level: Level.LOW,
        message: `Payout Method is also being used by other accounts`,
        details: compact(similarPayoutMethods.map(pm => pm.Collective?.slug)).join(', '),
      });
    }
  }

  return checks;
};
