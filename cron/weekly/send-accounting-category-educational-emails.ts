/**
 * This CRON job sends an email for all cases where a fiscal host admin selected a different accounting category
 * than the one selected by the expense submitted/collective admin.
 *
 * See https://github.com/opencollective/opencollective/issues/7053.
 */

import '../../server/env';

import { difference, get, has, isEmpty, orderBy, pick, size, uniq, uniqBy } from 'lodash';

import ActivityTypes from '../../server/constants/activities';
import { ExpenseRoles } from '../../server/constants/expense-roles';
import emailLib from '../../server/lib/email';
import logger from '../../server/lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import { deepJSONBSet } from '../../server/lib/sql';
import { parseToBoolean } from '../../server/lib/utils';
import { AccountingCategory, Expense, Op, sequelize, User } from '../../server/models';
import { onlyExecuteInProdOnMondays } from '../utils';

if (!process.env.MANUAL) {
  onlyExecuteInProdOnMondays();
}

/**
 * Check if the expense was misclassified by the given role.
 * Doesn't return expenses where `role` wasn't given a chance to pick the category (data.valuesByRole.{role}.accountingCategory is null).
 */
const shouldSendEmailForRole = (expense: Expense, role: ExpenseRoles | `${ExpenseRoles}`): boolean => {
  const selectedCategory = get(expense, `data.valuesByRole.${role}.accountingCategory`);
  return selectedCategory && selectedCategory.id !== expense.AccountingCategoryId;
};

export const getRecentMisclassifiedExpenses = async () => {
  const accountingCategoryIdCol = sequelize.cast(sequelize.col('Expense.AccountingCategoryId'), 'text');
  const valuesByRoleMismatchCondition = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: accountingCategoryIdCol }] };
  const expenses = await Expense.findAll({
    order: [['id', 'ASC']],
    where: {
      status: 'PAID',
      // Only look at recently edited/paid expenses
      updatedAt: { [Op.gt]: sequelize.literal("NOW() - INTERVAL '7 days'") },
      // Don't send if the expense was submitted more than a month ago (the user won't have fresh memory of it)
      createdAt: { [Op.gt]: sequelize.literal("NOW() - INTERVAL '1 month'") },
      // Only when we haven't sent the email yet
      data: { sentEmails: { 'expense-accounting-category-educational': { [Op.is]: null } } },
      // Only entries where the submitter/admin picked a different category
      [Op.or]: [
        { 'data.valuesByRole.collectiveAdmin.accountingCategory.id': valuesByRoleMismatchCondition },
        { 'data.valuesByRole.submitter.accountingCategory.id': valuesByRoleMismatchCondition },
      ],
    },
    include: [
      { association: 'accountingCategory', required: true },
      // The expense submitter
      { model: User, required: true, as: 'User' },
      // If not an individual, the payee profile and its admins
      {
        association: 'fromCollective',
        required: true,
        attributes: ['id', 'type'],
        include: [{ association: 'adminMembers', required: false, order: [['id', 'ASC']] }],
      },
      // The Collective, to get the admins
      {
        association: 'collective',
        required: true,
        where: { isActive: true },
        include: [
          { association: 'adminMembers', required: true, order: [['id', 'ASC']] }, // The collective admins to send the email to
          { association: 'host', required: true, include: [{ association: 'adminMembers', required: true }] }, // The host admins, to prevent sending the email to them
        ],
      },
      // Activities, to prevent sending the email to people who picked the right category when there are multiple admins
      {
        association: 'activities',
        required: false,
        order: [['id', 'DESC']],
        where: {
          type: [ActivityTypes.COLLECTIVE_EXPENSE_CREATED, ActivityTypes.COLLECTIVE_EXPENSE_UPDATED],
        },
      },
    ],
  });

  return expenses.filter(expense => {
    // Check the submitter/admins were allowed to pick the category
    return !expense.accountingCategory.hostOnly && expense.accountingCategory.isCompatibleWithExpenseType(expense.type);
  });
};

/**
 * Filters `collectiveIds` to return only the ones that got the accounting category wrong in the last expense.
 */
const getLastAccountingCategoryPick = (userId: number, expense: Expense): number => {
  if (!userId) {
    return undefined;
  }

  const userActivities = expense.activities.filter(a => a.UserId === userId);
  const orderedUserActivities = orderBy(userActivities, 'id', 'desc');
  const lastCategoryPick = orderedUserActivities.find(a => has(a.data, 'expense.AccountingCategoryId'));
  return lastCategoryPick?.data.expense.AccountingCategoryId;
};

const getCollectiveIdToUserMap = async (collectiveIds: number[]): Promise<Record<number, User>> => {
  const collectiveIdToUserIds: Record<number, User> = {};
  const allUsers = await User.findAll({
    where: { CollectiveId: uniq(collectiveIds) },
    include: [{ association: 'collective', required: true, attributes: ['id', 'name', 'legalName'] }],
  });
  for (const user of allUsers) {
    collectiveIdToUserIds[user.CollectiveId] = user;
  }
  return collectiveIdToUserIds;
};

type ClassificationMistake = {
  expense: Expense;
  role: ExpenseRoles;
  selectedCategoryId: number;
};

type GroupedMisclassifiedExpenses = Map<User, ClassificationMistake[]>;

export const groupMisclassifiedExpensesByAccount = async (
  expenses: Expense[],
): Promise<GroupedMisclassifiedExpenses> => {
  // Build a list of collectiveIds to check for each expense, when needed
  const toCheck = new Array<{ expense: Expense; collectiveIdsToCheck: Record<number, ExpenseRoles> }>();
  for (const expense of expenses) {
    const collectiveIdsToCheck: Record<number, ExpenseRoles> = {};
    const addCollectiveIdToCheck = (id: number, role: ExpenseRoles) => (collectiveIdsToCheck[id] = role);

    // For collective admins
    if (shouldSendEmailForRole(expense, 'collectiveAdmin')) {
      expense.collective.adminMembers.forEach(admin =>
        addCollectiveIdToCheck(admin.MemberCollectiveId, ExpenseRoles.collectiveAdmin),
      );
    }
    // For submitters & payee
    if (shouldSendEmailForRole(expense, 'submitter')) {
      // Check the submitter
      addCollectiveIdToCheck(expense.User.CollectiveId, ExpenseRoles.submitter);

      // If the payee is a collective/org, check if the admins picked the wrong category
      if (expense.fromCollective.type === 'USER') {
        addCollectiveIdToCheck(expense.FromCollectiveId, ExpenseRoles.submitter);
      } else {
        expense.fromCollective.adminMembers.map(admin =>
          addCollectiveIdToCheck(admin.MemberCollectiveId, ExpenseRoles.submitter),
        );
      }
    }

    // Filter out host admins
    expense.collective.host.adminMembers.forEach(admin => delete collectiveIdsToCheck[admin.MemberCollectiveId]);

    // Add to the list of expenses to check
    if (size(collectiveIdsToCheck) > 0) {
      toCheck.push({ expense, collectiveIdsToCheck });
    }
  }

  // Preload a map of all user ids from the collectives
  const collectiveIdToUser = await getCollectiveIdToUserMap(
    toCheck
      .map(({ collectiveIdsToCheck }) => Array.from(Object.keys(collectiveIdsToCheck)))
      .flat()
      .map(Number),
  );

  // Check all users
  const result: Record<number, ClassificationMistake[]> = {};
  for (const { expense, collectiveIdsToCheck } of toCheck) {
    for (const [collectiveId, role] of Object.entries(collectiveIdsToCheck)) {
      const user = collectiveIdToUser[collectiveId];
      const selectedCategoryId = getLastAccountingCategoryPick(user.id, expense);
      if (selectedCategoryId && selectedCategoryId !== expense.AccountingCategoryId) {
        result[collectiveId] = uniqBy(
          [...(result[collectiveId] || []), { expense, role, selectedCategoryId }],
          'expense.id',
        );
      }
    }
  }

  // Replace user ids with the actual user
  const userToMistakes: GroupedMisclassifiedExpenses = new Map();
  for (const [collectiveId, mistakes] of Object.entries(result)) {
    userToMistakes.set(collectiveIdToUser[collectiveId], mistakes);
  }

  return userToMistakes;
};

const buildAccountingCategoriesCache = async (
  groupedMistakes: GroupedMisclassifiedExpenses,
): Promise<Record<number, AccountingCategory>> => {
  const allExpenses = Array.from(groupedMistakes.values()).flatMap(mistakes => mistakes.map(({ expense }) => expense));
  const additionalAccountingCategoryIds = Array.from(groupedMistakes.values()).flatMap(mistakes =>
    mistakes.map(mistake => mistake.selectedCategoryId.toString()),
  );

  // Build base cache from the accounting categories of the expenses
  const result: Record<number, AccountingCategory> = {};
  allExpenses.forEach(expense => (result[expense.AccountingCategoryId] = expense.accountingCategory));

  // Load additional accounting categories
  const categoryIdsToLoad = difference(additionalAccountingCategoryIds, Object.keys(result));
  if (categoryIdsToLoad.length > 0) {
    const additionalAccountingCategories = await AccountingCategory.findAll({
      where: { id: additionalAccountingCategoryIds },
    });
    additionalAccountingCategories.forEach(category => (result[category.id] = category));
  }

  return result;
};

const prepareEmailData = (
  user: User,
  mistakes: ClassificationMistake[],
  accountingCategoriesCache: Record<number, AccountingCategory>,
) => {
  // Enrich the mistakes with the category from DB
  const mistakesWithCategories = mistakes
    .map(mistake => ({ ...mistake, selectedCategory: accountingCategoriesCache[mistake.selectedCategoryId] }))
    .filter(({ selectedCategory }) => selectedCategory); // Filter out categories that have been deleted

  if (!mistakesWithCategories.length) {
    return null;
  } else {
    const allHostsInfo = mistakesWithCategories.map(({ expense }) => expense.collective.host.info);
    return {
      recipientName: user.collective.name || user.collective.legalName,
      user: user.info,
      allRoles: uniq(mistakes.map(({ role }) => role)).sort(),
      allHosts: uniqBy(allHostsInfo, 'id'),
      mistakes: mistakesWithCategories.map(mistake => ({
        ...mistake,
        selectedCategory: mistake.selectedCategory.publicInfo,
        expense: {
          ...mistake.expense.info,
          accountingCategory: mistake.expense.accountingCategory.publicInfo,
          collective: mistake.expense.collective.info,
        },
      })),
    };
  }
};

const sendAllEmails = async (groupedMistakes: GroupedMisclassifiedExpenses): Promise<void> => {
  const accountingCategoriesCache = await buildAccountingCategoriesCache(groupedMistakes);
  const sentForExpenseIds = new Set<number>();
  const failures = [];
  for (const [user, mistakes] of Array.from(groupedMistakes.entries())) {
    try {
      const emailData = prepareEmailData(user, mistakes, accountingCategoriesCache);
      if (emailData) {
        await emailLib.send('expense-accounting-category-educational', user.email, emailData);
      }
      mistakes.forEach(({ expense }) => sentForExpenseIds.add(expense.id));
    } catch (e) {
      logger.error(`Error sending accounting category educational email to user ${user.id}:`, e);
      failures.push({ user: pick(user, ['id', 'CollectiveId', 'email']), error: e?.message || e });
    }
  }

  // Mark as sent
  for (const expenseId of sentForExpenseIds) {
    await sequelize.query(`
      UPDATE "Expenses"
      SET data = ${deepJSONBSet('data', ['sentEmails', 'expense-accounting-category-educational'], "'true'")}
      WHERE id = ${expenseId}
    `);
  }

  // Throw if any failure
  if (failures.length > 0) {
    reportMessageToSentry(`Failed to send emails to ${failures.length} collectives`, {
      extra: { failures },
      handler: 'CRON',
      severity: 'error',
    });

    throw new Error(`Failed to send emails to ${failures.length} collectives`);
  }
};

export const run = async () => {
  logger.info(`Starting accounting category educational emails job...`);

  const expenses = await getRecentMisclassifiedExpenses();
  const groupedMistakes = await groupMisclassifiedExpensesByAccount(expenses);
  if (isEmpty(groupedMistakes)) {
    logger.info('No expenses to send emails for.');
  } else {
    logger.info(`Found ${expenses.length} expenses to send emails for across ${size(groupedMistakes)} users.`);
    logger.info(
      Array.from(groupedMistakes.entries())
        .map(
          ([user, mistakes]) => `[User<${user.id}>: Expenses<${mistakes.map(({ expense }) => expense.id).join(',')}>]`,
        )
        .join(`, `),
    );

    if (!parseToBoolean(process.env.DRY_RUN)) {
      await sendAllEmails(groupedMistakes);
    }
  }

  logger.info('Done.');
};

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e, {
        handler: 'CRON',
        severity: 'error',
        transactionName: '92-send-accounting-category-educational-emails',
      });

      process.exit(1);
    });
}
