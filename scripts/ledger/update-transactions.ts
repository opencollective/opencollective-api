#!/usr/bin/env ./node_modules/.bin/ts-node

import '../../server/env.js';

import { Command } from 'commander';
import { groupBy, pick } from 'lodash-es';

import models, { Op } from '../../server/models/index.js';
import { confirm } from '../common/helpers.js';

// Some local caches to optimize the process
let accountsCache = {};

// Define modifiers as a map of option<>settings
const MODIFIERS = {
  hostFeePercent: {
    description: 'Update transactions with this host fee percent',
    parseArgs: value => {
      const result = parseFloat(value);
      if (isNaN(result)) {
        throw new Error(`Invalid host fee percent: ${value}`);
      } else if (!result) {
        throw new Error('Host fee percent cannot be 0'); // Not supported yet, but we could support it
      }

      return result;
    },
    shouldUpdate: transaction => {
      return transaction.type === 'CREDIT';
    },
    summarize: (transactions, percentage) => {
      return `Update ${transactions.length} transactions with ${percentage}% host fee`;
    },
    update: async (transaction, percentage) => {
      const existingHostFee = await transaction.getHostFeeTransaction();
      if (existingHostFee) {
        throw new Error("This script doesn't support updating existing host fee transactions yet"); // TODO: update existing host fee
      } else {
        const host = accountsCache[transaction.HostCollectiveId] || (await transaction.getHostCollective());
        accountsCache[transaction.HostCollectiveId] = host;
        transaction.hostFeeInHostCurrency = transaction.amount * (percentage / 100);
        await models.Transaction.createHostFeeTransactions(transaction, host);
      }
    },
  },
};

/** Parse command-line arguments */
const getProgram = argv => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  const commaSeparatedArgs = list => list.split(',');

  // Misc options
  program.option('--yes', 'Will not prompt for confirmation');

  // Filters
  program.option('--account <accounts>', 'Comma-separated list of accounts', commaSeparatedArgs);
  program.option('--kind <kinds>', 'Comma-separated list of transaction kinds', commaSeparatedArgs);

  // Value updaters
  Object.entries(MODIFIERS).forEach(([option, settings]) => {
    program.option(`--${option} <newValue>`, settings.description, settings.parseArgs);
  });

  // Parse arguments
  program.parse(argv);

  return program;
};

// Main
export const main = async (argv = process.argv) => {
  const program = getProgram(argv);
  const options = program.opts();
  const selectedModifiers = pick(MODIFIERS, Object.keys(options));

  // Validation
  const accountsSlugs = options.account || [];
  const accounts = await models.Collective.findAll({ where: { slug: accountsSlugs } });
  accountsCache = groupBy(accounts, 'id');
  const accountsIds = accounts.map(a => a.id);
  if (!accountsSlugs.length) {
    console.error('You must specify at least one account slug');
    program.help({ error: true });
  } else if (accounts.length !== accountsSlugs.length) {
    console.error('Some accounts were not found');
    program.help({ error: true });
  }

  if (options.hostFeePercent === undefined) {
    console.error('You must specify at least one info to update (hostFeePercent)');
    program.help({ error: true });
  }

  // Fetch transactions
  const where = { [Op.or]: [{ CollectiveId: accountsIds }, { FromCollectiveId: accountsIds }] };
  if (options.kind) {
    where['kind'] = options.kind;
  }

  const transactions = await models.Transaction.findAll({ where });

  // Display summary and ask confirmation
  console.log(`${transactions.length} transaction(s) to update with the following infos:`);
  Object.entries(selectedModifiers).forEach(([option, modifier]) => {
    const filteredTransactions = transactions.filter(modifier.shouldUpdate);
    console.log(`  - ${modifier.summarize(filteredTransactions, options[option])}`);
  });

  if (!options.yes) {
    const isConfirmed = await confirm('This action is irreversible. Are you sure you want to continue? (Yes/No)');
    if (!isConfirmed) {
      console.log('Aborted');
      return;
    }
  }

  // Trigger the actual update
  console.log('Updating transactions...');
  for (let i = 0; i < transactions.length; i++) {
    const transaction = transactions[i];
    // Apply all modifiers on transaction
    for (const [option, modifier] of Object.entries(selectedModifiers)) {
      if (modifier.shouldUpdate(transaction)) {
        await modifier.update(transaction, options[option]);
      }
    }

    if (i % 100 === 0) {
      console.log(`Processed ${i}/${transactions.length} transactions...`);
    }
  }

  console.log(`Processed ${transactions.length}/${transactions.length} transactions...`);
  console.log('Done!');
};

// Only run script if called directly (to allow unit tests)
import { pathToFileURL } from 'url'

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit())
    .catch(e => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }

      process.exit(1);
    });
}
