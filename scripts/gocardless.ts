import '../server/env';

import { Command } from 'commander';
import config from 'config';

import { Service } from '../server/constants/connected-account';
import { idDecode } from '../server/graphql/v2/identifiers';
import { getGoCardlessClient, getOrRefreshGoCardlessToken } from '../server/lib/gocardless/client';
import { getGoCardlessInstitutions, isGoCardlessSupportedCountry } from '../server/lib/gocardless/connect';
import { syncGoCardlessAccount } from '../server/lib/gocardless/sync';
import logger from '../server/lib/logger';
import { ConnectedAccount, TransactionsImport } from '../server/models';

const program = new Command();

const parseTransactionsImportId = (id: string): number => {
  if (/^\d+$/.test(id)) {
    return parseInt(id, 10);
  } else {
    return idDecode(id, 'transactions-import');
  }
};

program
  .command('sync')
  .argument('<transactionsImportId>', 'ID of the transactions import to sync')
  .description('Sync a connected GoCardless account')
  .option('-f, --full', 'Sync all transactions, not just new ones')
  .option('--date-from <date>', 'Start date for transaction sync (YYYY-MM-DD)')
  .option('--date-to <date>', 'End date for transaction sync (YYYY-MM-DD)')
  .option('--accounts <accounts>', 'Comma-separated list of account IDs to sync')
  .action(async (id, options) => {
    const importId = parseTransactionsImportId(id);
    const transactionsImport = await TransactionsImport.findByPk(importId);
    if (!transactionsImport) {
      throw new Error(`Transactions import with ID ${id} not found`);
    }

    const connectedAccount = await transactionsImport.getConnectedAccount();
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${id} not found`);
    }

    if (connectedAccount.service !== Service.GOCARDLESS) {
      throw new Error('Connected account is not a GoCardless account');
    }

    const syncOptions: Parameters<typeof syncGoCardlessAccount>[2] = { log: true };

    if (options.dateFrom) {
      syncOptions.dateFrom = new Date(options.dateFrom);
    }
    if (options.dateTo) {
      syncOptions.dateTo = new Date(options.dateTo);
    }
    if (options.accounts) {
      syncOptions.accounts = options.accounts.split(',').map(account => account.trim());
    }
    if (options.full) {
      syncOptions.full = true;
    }

    await syncGoCardlessAccount(connectedAccount, transactionsImport, syncOptions);
    logger.info(`Successfully synced GoCardless account for transactions import ${id}`);
  });

program
  .command('list-institutions')
  .argument('<country>', 'Country code (e.g., GB, DE, FR)')
  .description('List available GoCardless institutions for a country')
  .option('-f, --force-refresh', 'Force refresh the institutions list from API')
  .action(async (country, options) => {
    if (!isGoCardlessSupportedCountry(country)) {
      throw new Error(`Country ${country} is not supported by GoCardless`);
    }

    const institutions = await getGoCardlessInstitutions(country, {
      forceRefresh: options.forceRefresh,
    });

    console.log(`Available institutions for ${country}:`);
    institutions.forEach(institution => {
      console.log(`- ${institution.id}: ${institution.name}`);
    });
  });

program
  .command('get-institution')
  .argument('<institutionId>', 'GoCardless Institution ID')
  .description('Get a GoCardless institution by ID')
  .action(async institutionId => {
    const client = getGoCardlessClient();
    await getOrRefreshGoCardlessToken(client);
    const institution = await client.institution.getInstitutionById(institutionId);
    if (!institution) {
      throw new Error(`Institution with ID ${institutionId} not found`);
    }
    console.log(JSON.stringify(institution, null, 2));
  });

program
  .command('refresh-requisition')
  .argument('<connectedAccountId>', 'GoCardless Connected account ID to refresh')
  .description('Refresh GoCardless requisition data and accounts')
  .action(async connectedAccountId => {
    const connectedAccount = await ConnectedAccount.findByPk(connectedAccountId);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${connectedAccountId} not found`);
    }

    if (connectedAccount.service !== Service.GOCARDLESS) {
      throw new Error('The provided connected account is not a GoCardless account');
    }

    const client = getGoCardlessClient();
    await getOrRefreshGoCardlessToken(client);

    const requisition = await client.requisition.getRequisitionById(connectedAccount.clientId);
    const institution = await client.institution.getInstitutionById(requisition.institution_id);

    const accountsMetadata = await Promise.all(
      requisition.accounts.map(accountId => client.account(accountId).getMetadata()),
    );

    await connectedAccount.update({
      data: {
        ...connectedAccount.data,
        requisition,
        institution,
        accountsMetadata,
      },
    });

    logger.info(
      `Refreshed GoCardless requisition for connected account ${connectedAccountId}: ${JSON.stringify(
        {
          status: requisition.status,
          accounts: requisition.accounts,
          institution: institution.name,
        },
        null,
        2,
      )}`,
    );
  });

program
  .command('list-accounts')
  .argument('<connectedAccountId>', 'GoCardless Connected account ID')
  .description('List all accounts for a GoCardless connected account')
  .action(async connectedAccountId => {
    const connectedAccount = await ConnectedAccount.findByPk(connectedAccountId);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${connectedAccountId} not found`);
    }

    if (connectedAccount.service !== Service.GOCARDLESS) {
      throw new Error('The provided connected account is not a GoCardless account');
    }

    const accounts = connectedAccount.data.gocardless.requisition.accounts;
    const accountsMetadata = connectedAccount.data.gocardless.accountsMetadata || [];

    console.log(`Accounts for connected account ${connectedAccountId}:`);
    accounts.forEach((accountId, index) => {
      const metadata = accountsMetadata[index];
      console.log(`- ${accountId}: ${metadata?.name || 'Unknown account'}`);
    });
  });

// Sandbox commands
const throwIfNotSandbox = () => {
  if (config.gocardless?.env !== 'sandbox') {
    throw new Error('This command is only available in sandbox mode');
  }
};

program
  .command('test-connection')
  .argument('<connectedAccountId>', 'GoCardless Connected account ID')
  .description('[Sandbox only] Test the connection to a GoCardless account')
  .action(async connectedAccountId => {
    throwIfNotSandbox();

    const connectedAccount = await ConnectedAccount.findByPk(connectedAccountId);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${connectedAccountId} not found`);
    }

    if (connectedAccount.service !== Service.GOCARDLESS) {
      throw new Error('The provided connected account is not a GoCardless account');
    }

    const client = getGoCardlessClient();
    await getOrRefreshGoCardlessToken(client);

    try {
      const requisition = await client.requisition.getRequisitionById(connectedAccount.clientId);
      console.log('Connection test successful');
      console.log(`Requisition status: ${requisition.status}`);
      console.log(`Number of accounts: ${requisition.accounts?.length || 0}`);
    } catch (error) {
      console.error('Connection test failed:', error.message);
      throw error;
    }
  });

// Entrypoint
if (!module.parent) {
  program
    .parseAsync(process.argv)
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
