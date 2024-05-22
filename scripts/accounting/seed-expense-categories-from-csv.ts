import '../../server/env';

import fs from 'fs';

import axios from 'axios';
import { InvalidOptionArgumentError, program } from 'commander';
import { parse } from 'csv-parse/sync'; // eslint-disable-line

import models, { Op, sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

// Add a prefix to error logs to make them easier to find
const logError = (...messages: any) => {
  console.error('[ERROR]', ...messages);
};

const loadFileContents = async (filePathOrUrl: string): Promise<string> => {
  if (filePathOrUrl.match(/^https?:\/\//)) {
    const response = await axios.get(filePathOrUrl);
    return response.data;
  } else {
    const content = await fs.promises.readFile(filePathOrUrl, 'utf8');
    return content;
  }
};

type RunOptions = {
  verbose: boolean;
  start: number | null;
  end: number | null;
};

const run = async (hostSlug: string, csvPath: string, options: RunOptions) => {
  // Load host
  const host = await models.Collective.findOne({
    where: { slug: hostSlug },
    include: [{ association: 'accountingCategories', required: false }],
  });

  if (!host) {
    throw new Error(`Host ${hostSlug} not found`);
  }

  // Load CSV content
  const rawContent = await loadFileContents(csvPath);
  const parsedContent = parse(rawContent, {
    delimiter: ',',
    columns: true,
    skip_empty_lines: true, // eslint-disable-line camelcase
  });

  // Iterate over rows
  let rowIdx = options.start || 0;
  const selectedLines = parsedContent.slice(options.start || 0, options.end || parsedContent.length);
  for (const row of selectedLines) {
    rowIdx += 1;
    const shortTransactionGroup = row['Short Group ID'];
    const expenseAccountingCategoryCode = row['EXP CODE'];
    if (!shortTransactionGroup || !expenseAccountingCategoryCode) {
      if (options.verbose) {
        logError(`Missing data for row ${JSON.stringify(row)}`);
      }
      continue;
    }

    const expense = await models.Expense.findOne({
      include: [
        {
          model: models.Transaction,
          attributes: [],
          required: true,
          where: {
            type: 'DEBIT',
            kind: 'EXPENSE',
            HostCollectiveId: host.id,
            [Op.and]: [
              sequelize.where(sequelize.cast(sequelize.col('TransactionGroup'), 'text'), {
                [Op.startsWith]: shortTransactionGroup,
              }),
            ],
          },
        },
        {
          association: 'accountingCategory',
          required: false,
        },
      ],
    });

    if (!expense) {
      logError(`Expense not found for short transaction group ${shortTransactionGroup}`);
    } else if (expense.HostCollectiveId && expense.HostCollectiveId !== host.id) {
      logError(`Expense ${expense.id} is not associated with host ${hostSlug}`);
    } else if (expenseAccountingCategoryCode === expense.accountingCategory?.code) {
      if (options.verbose) {
        console.log(`Expense ${expense.id} already has the correct accounting category`);
      }
    } else {
      const newCategory = host.accountingCategories.find(({ code }) => code === expenseAccountingCategoryCode);
      if (!newCategory) {
        logError(`Accounting category ${expenseAccountingCategoryCode} not found for expense ${expense.id}`);
      } else {
        console.log(
          `Update Expense ${rowIdx}/${parsedContent.length} (#${expense.id}) with category ${newCategory.code} - ${newCategory.name}`,
        );
        if (!DRY_RUN) {
          await expense.update({ AccountingCategoryId: newCategory.id });
        }
      }
    }
  }
};

const parseIntOption = (value: string) => {
  if (!value) {
    return null;
  }

  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidOptionArgumentError('Not a number.');
  }

  return parsedValue;
};

const main = async () => {
  program
    .showHelpAfterError()
    .description('Seed expense categories from a CSV file')
    .argument('<hostSlug>', 'The host slug associated with the expenses')
    .argument('<filePath>', 'The path to the CSV file containing the expenses')
    .option('-v, --verbose', 'Verbose mode')
    .option('-s, --start <row>', 'Start at row', parseIntOption)
    .option('-e, --end <row>', 'End at row', parseIntOption)
    .action(async (hostSlug: string, filePath: string) => {
      try {
        await run(hostSlug, filePath, program.opts());
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  program.parseAsync();
};

main();
