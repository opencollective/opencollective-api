/**
 * Small helper to encode/decode GQLV2 identifiers with command-line.
 * The corresponding `HASHID_SALT` must be set in the environment (i.e. `.env.prod`, `.env` ...etc)
 */

import '../server/env';

import assert from 'assert';
import fs from 'fs';

import { Command } from 'commander';
import { toNumber } from 'lodash';
import moment from 'moment';

import { Service } from '../server/constants/connected-account';
import * as transferwiseLib from '../server/lib/transferwise';
import models, { Op, sequelize } from '../server/models';
import { PayoutMethodTypes } from '../server/models/PayoutMethod';

const program = new Command();

const printAndExit = (message, method = 'log') => {
  console[method](message);
  sequelize.close();
};

program.command('check-batch <batchId> [env]').action(async batchId => {
  console.log(`Checking batch ${batchId}`);
  const expenses = await models.Expense.findAll({
    where: {
      data: { batchGroup: { id: batchId } },
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'host', required: true },
    ],
  });
  if (!expenses.length) {
    return printAndExit(`Batch ${batchId} not found or not paid through the paltform.`, 'warn');
  }

  const host = expenses[0].host;
  const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
    throwIfMissing: false,
  });
  if (!connectedAccount) {
    return printAndExit(`${host.slug} not connected to Wise`, 'error');
  }

  const batch = await transferwiseLib.getBatchGroup(connectedAccount, batchId);
  if (!batch) {
    return printAndExit(`Batch ${batchId} not found`, 'error');
  }
  console.log(`Batch ${batchId} found:`);
  console.dir(batch);

  console.log('\n');
  const allExpensesWerePaid = expenses.every(expense => batch.transferIds.includes(expense.data.transfer.id));
  if (allExpensesWerePaid) {
    console.log(`✅ All expenses tracked on the platform were included in the batch`);
  } else {
    expenses
      .filter(expense => !batch.transferIds.includes(expense.data.transfer.id))
      .forEach(expense => {
        console.warn(`❌ Expense ${expense.id} for ${expense.collective.slug} was not included in the batch`);
      });
  }

  sequelize.close();
});

program.command('delete-stuck-batchs <hostSlug> <commaSeparatedBatchIds> [env]').action(async (hostSlug, ids) => {
  console.log(`Deleting stuck batchs ${ids} for host ${hostSlug}`);
  const host = await models.Collective.findOne({ where: { slug: hostSlug } });
  assert(host, `Host ${hostSlug} not found`);
  const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE);
  assert(connectedAccount, `${host.slug} not connected to Wise`);
  ids = ids.split(',');
  for (const id of ids) {
    const batch = await transferwiseLib.getBatchGroup(connectedAccount, id);
    if (!batch) {
      console.warn(`Batch ${id} not found`);
      continue;
    } else if (batch.status === 'NEW') {
      console.log(`Deleting stuck batch ${id}...`);
      await transferwiseLib.cancelBatchGroup(connectedAccount, batch.id, batch.version);
      console.log(`Batch ${id} deleted`);
    } else {
      console.log(`Batch ${id} was already processed or cancelled with status ${batch.status}`);
    }
  }
  sequelize.close();
});

program.command('check-expense <expenseId>').action(async expenseId => {
  console.log(`Checking expense ${expenseId}`);
  const expense = await models.Expense.findOne({
    where: {
      id: toNumber(expenseId),
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'host', required: true },
    ],
  });
  if (!expense) {
    return printAndExit(`Expense ${expenseId} not found or not paid using Wise.`, 'warn');
  }

  const connectedAccount = await expense.host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
    throwIfMissing: false,
  });
  if (!connectedAccount) {
    return printAndExit(`${expense.host.slug} not connected to Wise`, 'error');
  }
  const profileId = connectedAccount.data.id;
  console.info(`${expense.host.slug} connected to Wise with profileId ${profileId}`);

  const transfer = await transferwiseLib.getTransfer(connectedAccount, expense.data.transfer['id']);
  const recipient = await transferwiseLib.getRecipient(connectedAccount, transfer.targetAccount);
  const quote = await transferwiseLib.getQuote(connectedAccount, transfer.quoteUuid);
  const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
  console.dir({ transfer, recipient, quote, paymentOption }, { depth: null });

  if (
    'price' in expense.data.paymentOption && // Check if it is QuoteV3
    paymentOption.price.priceDecisionReferenceId !== expense.data.paymentOption.price?.priceDecisionReferenceId
  ) {
    console.warn(
      `Payment option mismatch! Reference stored in DB: ${expense.data.paymentOption.price?.priceDecisionReferenceId}, reference from Wise: ${paymentOption.price.priceDecisionReferenceId}`,
    );
  }
  sequelize.close();
});

const checkPaymentProcessorFee = ({ expense, quote }) => {
  const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
  assert.equal(expense.data.paymentOption.fee.total, paymentOption.fee.total, `Fee mismatch`);
};

program.command('check-host <hostSlug> [since] [until]').action(async (hostSlug, since, until) => {
  since = moment.utc(since);
  if (!since.isValid()) {
    since = moment.utc().startOf('year').format();
  }
  until = moment.utc(until);
  if (!until.isValid()) {
    until = moment.utc().format();
  }
  console.log(`Checking expense for host ${hostSlug} since ${since}`);
  const host = await models.Collective.findOne({ where: { slug: hostSlug } });
  const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE);
  if (!connectedAccount) {
    return printAndExit(`${host.slug} not connected to Wise`, 'error');
  }
  const expenses = await models.Expense.findAll({
    where: {
      HostCollectiveId: host.id,
      status: 'PAID',
      createdAt: { [Op.between]: [since, until] },
      data: { transfer: { [Op.ne]: null } },
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'host', required: true },
      {
        model: models.PayoutMethod,
        as: 'PayoutMethod',
        required: true,
        where: { type: PayoutMethodTypes.BANK_ACCOUNT },
      },
    ],
  });

  const problems = [['ExpenseId', 'CollectiveSlug', 'CreatedAt', 'Problem', 'Actual', 'Expected']];
  console.log(`Found ${expenses.length} expenses...`);
  for (const expense of expenses) {
    const transfer = await transferwiseLib.getTransfer(connectedAccount, expense.data.transfer['id']);
    const quote = await transferwiseLib.getQuote(connectedAccount, transfer.quoteUuid);
    try {
      checkPaymentProcessorFee({ expense, quote });
      console.log(`✅ Expense #${expense.id} for ${expense.collective.slug}`);
    } catch (e) {
      problems.push([expense.id, expense.collective.slug, expense.createdAt, e.message, e.actual, e.expected]);
      console.log(`❌ Expense #${expense.id} for ${expense.collective.slug} failed check: ${e.message}`);
    }
  }

  if (problems.length > 1) {
    console.error(`Found ${problems.length - 1} problems, writting it to wise-check.csv`);
    fs.writeFileSync('wise-check.csv', problems.map(row => row.join(',')).join('\n'));
  }

  sequelize.close();
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/wise.ts check-expense expenseId
  $ npm run script scripts/wise.ts delete-stuck-batchs europe '242db7eb-466b-49fd-9233-d6ec51671910,041d0772-26e4-4913-be56-adf725096fb9' prod
`,
);

program.parse();
