/**
 * A script to check the legal documents required for an expense, and create them if needed.
 */

import '../../server/env';

import { Command } from 'commander';
import { difference } from 'lodash';

import logger from '../../server/lib/logger';
import SQLQueries from '../../server/lib/queries';
import models, { Expense, Op } from '../../server/models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_TYPE } from '../../server/models/LegalDocument';

const parseCommandLine = () => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.option('--expenses <expenseIds>', 'Expense IDs to check');
  program.option('--host <hostSlug>', 'Host slug to check');
  program.option('--update', 'Make changes to the database');
  program.option('--year <year>', 'Year to check. Default: current year');
  program.parse();

  const options = program.opts();
  return {
    expenseIds: options.expenses?.split(',').map(Number) || [],
    mustUpdate: options.update,
    hostSlug: options.host,
    year: options.year ? Number(options.year) : new Date().getFullYear(),
  };
};

const expenseURL = (expense: Expense) => {
  return `https://opencollective.com/${expense.collective.slug}/expenses/${expense.id}`;
};

const main = async () => {
  const { expenseIds, mustUpdate, hostSlug, year } = parseCommandLine();

  const whereHost = hostSlug ? { slug: hostSlug } : {};
  const expenses = await models.Expense.findAll({
    where: {
      ...(expenseIds.length ? { id: expenseIds } : {}),
      createdAt: { [Op.gte]: new Date(year, 0, 1) },
    },
    include: [
      { association: 'User', required: true },
      { association: 'fromCollective', required: true },
      { association: 'host', required: false, where: whereHost },
      {
        association: 'collective',
        required: true,
        include: [{ association: 'host', required: true, where: whereHost }],
      },
    ],
  });

  console.log(`${expenses.length} expenses to check`);

  // Log not found
  if (expenseIds) {
    const notFound = difference(
      expenseIds,
      expenses.map(e => e.id),
    );
    if (notFound.length) {
      logger.warn(`Some expenses were not found: ${notFound.join(', ')}`);
    }
  }

  if (!expenses.length) {
    return;
  }

  // Check tax form statuses
  const taxFormRequiredForExpenseIds = await SQLQueries.getTaxFormsRequiredForExpenses(expenses.map(e => e.id));

  // Process expenses
  for (const expense of expenses) {
    const host = expense.host ?? expense.collective.host;
    if (!host) {
      logger.error(`Expense ${expenseURL(expense)} has no host`);
      continue;
    }

    const existingTaxForm = await models.LegalDocument.findOne({
      where: {
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        CollectiveId: expense.FromCollectiveId,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
      },
    });

    const isMissingTaxForm = !existingTaxForm && taxFormRequiredForExpenseIds.has(expense.id);
    if (isMissingTaxForm) {
      logger.warn(`=> ${expenseURL(expense)} is missing a tax form`);
    }

    if (mustUpdate && isMissingTaxForm) {
      const taxForm = await expense.updateTaxFormStatus(host, expense.fromCollective, expense.User);
      if (!taxForm) {
        logger.info(`[Fix] Expense #${expense.id} has no tax form required`);
      } else {
        logger.info(`[Fix] Tax form for Expense #${expense.id}: ${taxForm.id}, ${taxForm.requestStatus}`);
      }
    }
  }

  console.log('Done ✓');
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
