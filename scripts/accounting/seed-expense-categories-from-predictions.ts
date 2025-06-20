/*
 ** An interactive script to seed expense categories from ML predictions service.
 */

import '../../server/env';

import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { program } from 'commander';
import { cloneDeep, set } from 'lodash';
import moment from 'moment';

import logger from '../../server/lib/logger';
import {
  ExpenseCategoryPrediction,
  ExpensePredictions,
  fetchExpenseCategoryPredictionsWithEmbedding,
  fetchExpenseCategoryPredictionsWithLLM,
  fetchExpenseCategoryPredictionsWithSVC,
  FetchPredictionsResult,
} from '../../server/lib/ml-service';
import models, { AccountingCategory, Collective, Expense, Op } from '../../server/models';

const BATCH_SIZE = 5;

type RunOptions = {
  apply: boolean;
  verbose: boolean;
  startDate: string | null;
  endDate: string | null;
  csv: string | null;
};

type CategoryOption = {
  code: string;
  name: string;
  confidence?: number;
  isPrediction: boolean;
};

const getOptions = (
  predictions: ExpenseCategoryPrediction[],
  categories: AccountingCategory[],
): [CategoryOption[], CategoryOption[]] => {
  // Start with predictions, sorted by confidence
  const predictionOptions = predictions.map(p => ({
    code: p.code,
    name: categories.find(c => c.code === p.code)?.name || 'Unknown',
    confidence: p.confidence,
    isPrediction: true,
  }));

  // Add all other categories that weren't predicted
  const predictedCodes = new Set(predictions.map(p => p.code));
  const otherOptions = categories
    .filter(cat => !predictedCodes.has(cat.code))
    .map(cat => ({
      code: cat.code,
      name: cat.name,
      isPrediction: false,
    }));

  return [predictionOptions, otherOptions];
};

const confirmPrediction = async (expense, predictions, categories): Promise<number | null> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let promptMsg = `\n${expense.incurredAt.toISOString()} Expense #${expense.id} (${expense.description})\n`;
  const itemDetails = expense.items.map(item => `${item.description} (${item.amount})`).join(', ');
  promptMsg += `Items: ${itemDetails}\n\n`;

  const [predictionOptions, otherOptions] = getOptions(predictions, categories);

  promptMsg += 'Possible categories:\n';
  predictionOptions.forEach((opt, idx) => {
    promptMsg += `  ${idx + 1}. ${opt.code} (${opt.name}) - confidence: ${(opt.confidence * 100).toFixed(1)}%\n`;
  });

  otherOptions.forEach((opt, idx) => {
    promptMsg += `  ${idx + predictionOptions.length + 1}. ${opt.code} (${opt.name})\n`;
  });

  promptMsg += '\nChoose: [1-N] select category, [s]kip (default)\n> ';

  const allOptions = [...predictionOptions, ...otherOptions];
  return new Promise(resolve => {
    rl.question(promptMsg, input => {
      rl.close();
      input = input.trim().toLowerCase();

      // If input is a number, use it as index
      const index = parseInt(input);
      if (!isNaN(index) && index >= 0 && index < allOptions.length) {
        const selectedOption = allOptions[index];
        const category = categories.find(c => c.code === selectedOption.code);
        return resolve(category ? index : null);
      }

      // Default: try again
      return resolve(null);
    });
  });
};

const updateExpenseWithCategory = async (expense: Expense, category: AccountingCategory) => {
  const expenseData = cloneDeep(expense.data) || {};
  set(expenseData, 'valuesByRole.prediction.accountingCategory', category.publicInfo);
  await expense.update({ AccountingCategoryId: category.id, data: expenseData });
};

const isCategoryCompatible = (host: Collective, expense: Expense, category: AccountingCategory) => {
  const isHostExpense = (expense.collective.ParentCollectiveId ?? expense.collective.id) === host.id;
  if (category.appliesTo === 'HOST') {
    return isHostExpense;
  } else if (category.appliesTo === 'HOSTED_COLLECTIVES') {
    return !isHostExpense;
  } else {
    return true;
  }
};

const writeCsvLine = (expense: Expense, category: AccountingCategory, csvStream: fs.WriteStream) => {
  const expenseUrl = `https://opencollective.com/${expense.collective.slug}/expenses/${expense.id}`;
  csvStream.write(`${expenseUrl},${expense.description},${category.code},${category.name}\n`);
};

const run = async (hostSlug: string, model: string, options: RunOptions) => {
  // Check model
  if (model !== 'SVC' && model !== 'EMBEDDING' && model !== 'LLM') {
    throw new Error(`Invalid model: ${model}. Must be one of: SVC, EMBEDDING, LLM`);
  }

  // Parse dates
  const startDate = options.startDate ? moment(options.startDate) : moment().startOf('year');
  const endDate = options.endDate ? moment(options.endDate) : moment();

  // Initialize CSV output if needed
  let csvStream: fs.WriteStream | null = null;
  if (options.csv) {
    const csvPath = path.resolve(options.csv);
    csvStream = fs.createWriteStream(csvPath);
    csvStream.write('EXPENSE_URL,EXPENSE_DESCRIPTION,CATEGORY_CODE,CATEGORY_NAME\n');
  }

  // Load host and categories
  const host = await models.Collective.findOne({
    where: { slug: hostSlug },
    include: [{ association: 'accountingCategories', required: false }],
  });
  if (!host) {
    throw new Error(`Host ${hostSlug} not found`);
  } else if (!host.accountingCategories?.length) {
    throw new Error(
      `Host ${hostSlug} has no accounting categories. Please set up a chart of accounts before running this script.`,
    );
  }

  const categories = host.accountingCategories || [];

  // Find all expenses without an accounting category in the date range
  const expenses = await models.Expense.findAll({
    where: {
      HostCollectiveId: host.id,
      AccountingCategoryId: { [Op.is]: null },
      incurredAt: { [Op.gte]: startDate.toDate(), [Op.lte]: endDate.toDate() },
    },
    include: [
      { association: 'items', required: true },
      { association: 'collective', required: true },
    ],
    order: [['incurredAt', 'ASC']],
  });

  if (!expenses.length) {
    logger.info('No expenses without accounting category found in the given range.');
    return;
  }

  logger.info(`Found ${expenses.length} expenses without accounting category.`);

  // Batch expenses and call ML API
  for (let i = 0; i < expenses.length; i += BATCH_SIZE) {
    const batch = expenses.slice(i, i + BATCH_SIZE);
    const mlInputs = await Promise.all(
      batch.map(async expense => ({
        id: String(expense.id),
        description: expense.description,
        appliesTo:
          (expense.collective.ParentCollectiveId ?? expense.collective.id) === host.id ? 'HOST' : 'HOSTED_ACCOUNTS',
        items: expense.items
          .map(item => item.description)
          .filter(Boolean)
          .join(', '),
      })),
    );

    let mlExpenses: ExpensePredictions[] = [];
    try {
      let result: FetchPredictionsResult;
      if (model === 'SVC') {
        result = await fetchExpenseCategoryPredictionsWithSVC(hostSlug, mlInputs);
      } else if (model === 'EMBEDDING') {
        result = await fetchExpenseCategoryPredictionsWithEmbedding(hostSlug, mlInputs);
      } else {
        result = await fetchExpenseCategoryPredictionsWithLLM(hostSlug, mlInputs, categories);
      }
      mlExpenses = result.expenses || [];
    } catch (error) {
      const errorMessage = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error('ML API call failed:', errorMessage);
      continue;
    }

    for (const mlExpense of mlExpenses) {
      const expense = batch.find(e => String(e.id) === String(mlExpense.id));
      if (!expense) {
        continue;
      }
      const predictions = mlExpense.predictions || [];
      if (!predictions.length) {
        if (options.verbose) {
          logger.info(`No predictions for expense #${expense.id}`);
        }
        continue;
      }
      // Only consider predictions that match a valid category
      const validPredictions = predictions.filter(p => {
        const category = categories.find(c => c.code === p.code);
        if (!category) {
          logger.error(`Category code ${p.code} not found for host ${hostSlug}`);
          return false;
        }

        return isCategoryCompatible(host, expense, category);
      });

      if (!validPredictions.length) {
        logger.info(`No valid predictions for expense #${expense.id}`);
        continue;
      }

      if (options.csv) {
        // In CSV mode, just write the top prediction
        const top = validPredictions[0];
        const category = categories.find(c => c.code === top.code);
        writeCsvLine(expense, category, csvStream);
        if (options.verbose) {
          logger.info(`Wrote CSV line for expense #${expense.id}: ${category.code}`);
        }
      } else if (options.apply) {
        // Apply top valid prediction automatically
        const top = validPredictions[0];
        const category = categories.find(c => c.code === top.code);
        const msg = `${expense.incurredAt.toISOString()} Expense #${expense.id} (${expense.description}): predicted category ${category.code} (${category.name}), confidence ${top.confidence}`;
        logger.info(`${msg} [APPLY]`);

        await updateExpenseWithCategory(expense, category);
      } else {
        // Interactive: show top 3, prompt for action
        const idx = await confirmPrediction(expense, validPredictions, categories);
        if (idx === null) {
          logger.info('Skipped.');
          continue;
        }
        const selected = validPredictions[idx];
        const category = categories.find(c => c.code === selected.code);
        if (!category) {
          logger.error(`Selected category code ${selected.code} not found for expense #${expense.id}`);
          continue;
        }
        logger.info(
          `Applying category ${category.code} (${category.name}) to expense https://opencollective.com/${expense.collective.slug}/expenses/${expense.id}`,
        );

        await updateExpenseWithCategory(expense, category);
      }
    }
  }

  // Close CSV stream if it was opened
  if (csvStream) {
    csvStream.end();
    logger.info(`CSV output written to ${options.csv}`);
  }
};

const main = async () => {
  program
    .showHelpAfterError()
    .description('Seed expense categories from ML predictions')
    .argument('<hostSlug>', 'The host slug associated with the expenses')
    .argument('<model>', 'The model to use for predictions. Must be one of: SVC, EMBEDDING, LLM')
    .option('--startDate <date>', 'Start date (YYYY-MM-DD)', null)
    .option('--endDate <date>', 'End date (YYYY-MM-DD)', null)
    .option('--apply', 'Apply all suggestions without confirmation')
    .option('-v, --verbose', 'Verbose mode')
    .option('--csv <path>', 'Output predictions to CSV file instead of modifying database')
    .action(async (hostSlug: string, model: string) => {
      try {
        await run(hostSlug, model.toUpperCase(), program.opts());
        logger.info('Done.');
        process.exit(0);
      } catch (err) {
        logger.error(JSON.stringify(err, Object.getOwnPropertyNames(err)));
        process.exit(1);
      }
    });

  program.parseAsync();
};

main();
