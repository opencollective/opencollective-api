import '../server/env.js';

import { Command } from 'commander';
import { toNumber } from 'lodash-es';

import { Service } from '../server/constants/connected_account.js';
import * as transferwiseLib from '../server/lib/transferwise.js';
import models, { sequelize } from '../server/models/index.js';

const program = new Command();

const printAndExit = (message, method = 'log') => {
  console[method](message);
  sequelize.close();
};

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

  const [connectedAccount] = await expense.host.getConnectedAccounts({
    where: { service: Service.TRANSFERWISE, deletedAt: null },
  });
  if (!connectedAccount) {
    return printAndExit(`${expense.host.slug} not connected to Wise`, 'error');
  }
  const profileId = connectedAccount.data.id;
  console.info(`${expense.host.slug} connected to Wise with profileId ${profileId}`);

  const transfer = await transferwiseLib.getTransfer(connectedAccount, expense.data.transfer['id']);
  const recipient = await transferwiseLib.getRecipient(connectedAccount, transfer.targetAccount);
  console.dir({ transfer, recipient }, { depth: null });
  sequelize.close();
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/wise.ts check-expense expenseId
`,
);

program.parse();
