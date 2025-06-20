import '../../server/env';

import { groupBy } from 'lodash';

import { FEATURE, hasFeature } from '../../server/lib/allowed-features';
import logger from '../../server/lib/logger';
import { fetchExpenseCategoryPredictionsWithLLM } from '../../server/lib/ml-service';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { deepJSONBSet } from '../../server/lib/sql';
import models, { AccountingCategory, Collective, Expense, sequelize } from '../../server/models';
import { AccountingCategoryAppliesTo } from '../../server/models/AccountingCategory';
import { runCronJob } from '../utils';

/**
 * Generator that yields batches of expenses for prediction processing.
 * Groups expenses by host and appliesTo (HOST vs HOSTED_COLLECTIVES).
 * Never yields more than 10 expenses at a time.
 */
async function* getExpensesBatch(
  host: Collective,
  expenses: Expense[],
): AsyncGenerator<{
  expenses: Expense[];
  appliesTo: AccountingCategoryAppliesTo;
  accountingCategories: AccountingCategory[];
}> {
  // Group by appliesTo within this host
  const hostExpensesByAppliesTo: Partial<Record<AccountingCategoryAppliesTo, Expense[]>> = groupBy(expenses, expense =>
    [expense.collective.id, expense.collective.ParentCollectiveId].includes(host.id) ? 'HOST' : 'HOSTED_COLLECTIVES',
  );

  // Process each appliesTo group
  for (const appliesTo of Object.keys(hostExpensesByAppliesTo)) {
    const appliesToExpenses = hostExpensesByAppliesTo[appliesTo];

    // Yield in batches of max 10
    for (let i = 0; i < appliesToExpenses.length; i += 10) {
      const batch = appliesToExpenses.slice(i, i + 10);
      yield {
        expenses: batch,
        appliesTo: appliesTo as AccountingCategoryAppliesTo,
        accountingCategories: host.accountingCategories.filter(
          category => !category.appliesTo || category.appliesTo === appliesTo,
        ),
      };
    }
  }
}

const getFirstValidPrediction = (
  expense: Expense,
  accountingCategories: AccountingCategory[],
  predictions: Awaited<ReturnType<typeof fetchExpenseCategoryPredictionsWithLLM>>['expenses'][number],
): AccountingCategory | null => {
  for (const prediction of predictions.predictions) {
    const matchingCategory = accountingCategories.find(category => category.code === prediction.code);
    if (!matchingCategory) {
      continue;
    } else if (matchingCategory.expensesTypes && !matchingCategory.expensesTypes.includes(expense.type)) {
      continue;
    }

    return matchingCategory;
  }

  return null;
};

const run = async () => {
  // 1. List all hosts with the ACCOUNTING_CATEGORY_PREDICTIONS feature enabled and a chart of accounts
  const hostsWithFeature = await models.Collective.findAll({
    where: {
      isHostAccount: true,
      isActive: true,
      data: {
        features: {
          [FEATURE.ACCOUNTING_CATEGORY_PREDICTIONS]: true,
        },
      },
    },
    include: [
      {
        association: 'accountingCategories',
        where: { kind: 'EXPENSE' },
        required: true,
      },
    ],
  });

  const eligibleHosts = hostsWithFeature.filter(host => hasFeature(host, FEATURE.ACCOUNTING_CATEGORY_PREDICTIONS));
  if (!eligibleHosts.length) {
    logger.info('No hosts with ACCOUNTING_CATEGORY_PREDICTIONS feature found');
    return;
  }

  logger.info(`Found ${eligibleHosts.length} hosts with ACCOUNTING_CATEGORY_PREDICTIONS feature`);

  // 2. List all expenses with pending verifications (no prediction stored in data)
  for (const host of eligibleHosts) {
    const pendingExpenses = await models.Expense.findAll({
      where: {
        HostCollectiveId: host.id,
        status: 'PAID',
        AccountingCategoryId: null,
        data: {
          valuesByRole: {
            prediction: {
              accountingCategory: null,
            },
          },
        },
      },
      include: [
        { association: 'items', required: true },
        { association: 'collective', required: true },
      ],
      order: [['createdAt', 'ASC']],
    });

    // Filter out expenses that already have predictions stored in data
    if (!pendingExpenses.length) {
      logger.info('No expenses with pending predictions found');
      return;
    }

    logger.info(`Found ${pendingExpenses.length} expenses with pending predictions for host ${host.slug}`);

    // 3. Process expenses in batches using the generator
    for await (const batch of getExpensesBatch(host, pendingExpenses)) {
      const preparedExpenses = batch.expenses.map(expense => ({
        id: expense.id.toString(),
        description: expense.description,
        items: expense.items.map(item => item.description).join(', '),
        appliesTo: batch.appliesTo,
      }));

      try {
        const fetchedPredictions = await fetchExpenseCategoryPredictionsWithLLM(
          host.slug,
          preparedExpenses,
          batch.accountingCategories,
        );

        for (const prediction of fetchedPredictions.expenses) {
          const expense = batch.expenses.find(expense => expense.id === Number(prediction.id));
          if (expense) {
            const validPrediction = getFirstValidPrediction(expense, batch.accountingCategories, prediction);
            if (validPrediction) {
              await sequelize.query(
                `
              UPDATE "Expenses"
              SET "data" = ${deepJSONBSet('data', ['valuesByRole', 'prediction', 'accountingCategory'], ':categoryInfo')}
              WHERE "id" = :expenseId
            `,
                {
                  replacements: {
                    categoryInfo: JSON.stringify(validPrediction.publicInfo),
                    expenseId: expense.id,
                  },
                },
              );
              logger.debug(`Processed prediction for expense #${expense.id}: ${validPrediction.code}`);
            }
          }
        }

        logger.info(`Processed ${batch.expenses.length} expenses for host ${host.slug}`);
      } catch (error) {
        logger.error(`Error processing batch for host ${host.slug}:`, error);
        reportErrorToSentry(error, {
          handler: 'CRON',
          extra: {
            hostSlug: host.slug,
            expenseCount: batch.expenses.length,
          },
        });
      }
    }
  }

  const message = `Expense predictions processed`;
  logger.info(message);
};

if (require.main === module) {
  runCronJob('process-expense-predictions', run, 60 * 60);
}
