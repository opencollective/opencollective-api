import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { FEATURE, hasFeature } from '../../lib/allowed-features';
import { fetchExpenseCategoryPredictionsWithLLM } from '../../lib/ml-service';
import { reportErrorToSentry } from '../../lib/sentry';
import { deepJSONBSet } from '../../lib/sql';
import models, { AccountingCategory, Collective, Expense, sequelize } from '../../models';
import { AccountingCategoryAppliesTo } from '../../models/AccountingCategory';

/**
 * Generator that yields batches of expenses for prediction processing.
 * Groups expenses by host and appliesTo (HOST vs HOSTED_COLLECTIVES).
 * Never yields more than 10 expenses at a time.
 */
async function* getExpensesBatch(
  expenses: Expense[],
  req: Express.Request,
): AsyncGenerator<{
  expenses: Expense[];
  appliesTo: AccountingCategoryAppliesTo;
  accountingCategories: AccountingCategory[];
  host: Collective;
}> {
  // Preload data (host + collective)
  await Promise.all(
    expenses.map(async expense => {
      expense.items = expense.items ?? (await req.loaders.Expense.items.load(expense.id));
      expense.collective = expense.collective ?? (await req.loaders.Collective.byId.load(expense.CollectiveId));
      expense.host =
        expense.host ??
        (await (expense.HostCollectiveId
          ? req.loaders.Collective.byId.load(expense.HostCollectiveId)
          : req.loaders.Collective.byId.load(expense.collective.HostCollectiveId)));
    }),
  );

  // Filter out expenses that can't be predicted
  console.log('expenses', expenses[0].host.data.features);
  expenses = expenses.filter(
    expense => expense.host && hasFeature(expense.host, FEATURE.ACCOUNTING_CATEGORY_PREDICTIONS),
  );

  const expensesByHost = groupBy(expenses, 'host.id');
  for (const hostId of Object.keys(expensesByHost)) {
    const hostExpenses = expensesByHost[hostId];
    const accountingCategories = await models.AccountingCategory.findAll({
      where: { CollectiveId: hostId, kind: 'EXPENSE' },
    });

    // Group by appliesTo within this host
    const hostExpensesByAppliesTo: Partial<Record<AccountingCategoryAppliesTo, Expense[]>> = groupBy(
      hostExpenses,
      expense =>
        [expense.collective.id, expense.collective.ParentCollectiveId].includes(Number(hostId))
          ? 'HOST'
          : 'HOSTED_COLLECTIVES',
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
          host: hostExpenses[0].host,
          accountingCategories: accountingCategories.filter(
            category => !category.appliesTo || category.appliesTo === appliesTo,
          ),
        };
      }
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

export const fetchPredictionForExpense = (req: Express.Request): DataLoader<Expense, AccountingCategory | null> => {
  return new DataLoader(async (expenses: Expense[]) => {
    const predictions: Record<number, AccountingCategory | null> = {};

    // Check expenses that already have a prediction stored in data
    const expensesToFetch: Expense[] = [];
    for (const expense of expenses) {
      if (expense.data.valuesByRole?.prediction?.accountingCategory) {
        const category = expense.data.valuesByRole.prediction.accountingCategory;
        if (category && category.id) {
          predictions[expense.id] = category as AccountingCategory;
        }
      } else {
        expensesToFetch.push(expense);
      }
    }

    if (!expensesToFetch.length) {
      return expenses.map(expense => predictions[expense.id] || null);
    }

    // Process expenses in batches using the generator
    for await (const batch of getExpensesBatch(expensesToFetch, req)) {
      const preparedExpenses = batch.expenses.map(expense => ({
        id: expense.id.toString(),
        description: expense.description,
        items: expense.items.map(item => item.description).join(', '),
        appliesTo: batch.appliesTo,
      }));

      try {
        const fetchedPredictions = await fetchExpenseCategoryPredictionsWithLLM(
          batch.host.slug,
          preparedExpenses,
          batch.accountingCategories,
        );

        for (const prediction of fetchedPredictions.expenses) {
          const expense = batch.expenses.find(expense => expense.id === prediction.id);
          if (expense) {
            const validPrediction = getFirstValidPrediction(expense, batch.accountingCategories, prediction);
            if (validPrediction) {
              predictions[expense.id] = validPrediction;
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
            }
          }
        }
      } catch (error) {
        // Report error, but continue with the next batch
        reportErrorToSentry(error);
      }
    }

    // Return predictions for all expenses
    return expenses.map(expense => predictions[expense.id] || null);
  });
};
