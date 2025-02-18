import '../server/env';

import { Command } from 'commander';
import config from 'config';
import { SandboxItemFireWebhookRequestWebhookCodeEnum } from 'plaid';

import { Service } from '../server/constants/connected-account';
import { idDecode } from '../server/graphql/v2/identifiers';
import logger from '../server/lib/logger';
import { getPlaidClient } from '../server/lib/plaid/client';
import { refreshPlaidSubAccounts } from '../server/lib/plaid/connect';
import { syncPlaidAccount } from '../server/lib/plaid/sync';
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
  .description('Sync a connected Plaid account')
  .option('-f, --full', 'Sync all transactions, not just new ones')
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

    await syncPlaidAccount(connectedAccount, { log: true, full: options.full });
  });

program
  .command('refresh-accounts')
  .argument('[connectedAccountId]', 'Plaid Connected account ID to refresh (defaults to all Plaid accounts)')
  .description('Refresh Plaid sub-accounts, storing the latest ones available in the transactions import')
  .action(async connectedAccountId => {
    const connectedAccounts = connectedAccountId
      ? [await ConnectedAccount.findByPk(connectedAccountId)]
      : await ConnectedAccount.findAll({ where: { service: Service.PLAID } });

    if (connectedAccounts.some(connectedAccount => connectedAccount.service !== Service.PLAID)) {
      throw new Error('The provided connected account is not a Plaid account');
    }

    for (const connectedAccount of connectedAccounts) {
      const transactionsImport = await TransactionsImport.findOne({
        where: { ConnectedAccountId: connectedAccount.id, type: 'PLAID' },
      });
      if (!transactionsImport) {
        logger.warn('No Plaid transactions import found for the connected account');
        continue;
      }

      await refreshPlaidSubAccounts(connectedAccount, transactionsImport);
      logger.info(
        `Refreshed Plaid sub-accounts for connected account ${connectedAccount.id}: ${JSON.stringify(transactionsImport.data?.plaid?.availableAccounts, null, 2)}`,
      );
    }
  });

// Sandbox commands
const throwIfNotSandbox = () => {
  if (config.plaid.env !== 'sandbox') {
    throw new Error('This command is only available in sandbox mode');
  }
};

program
  .command('fire-webhook')
  .argument('<id>', 'Connected account ID')
  .argument(
    '<webhookCode>',
    `Webhook code to fire. Must be one of: (${Object.values(SandboxItemFireWebhookRequestWebhookCodeEnum).join(', ')})`,
  )
  .description('[Sandbox only] Fire a Plaid webhook event')
  .action(async (connectedAccountId, webhookCode) => {
    throwIfNotSandbox();

    const connectedAccount = await ConnectedAccount.findByPk(connectedAccountId);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${connectedAccountId} not found`);
    } else if (!Object.values(SandboxItemFireWebhookRequestWebhookCodeEnum).includes(webhookCode)) {
      throw new Error(
        `Invalid webhook code: ${webhookCode}. Must be one of: (${Object.values(SandboxItemFireWebhookRequestWebhookCodeEnum).join(', ')})`,
      );
    }

    const PlaidClient = getPlaidClient();
    const response = await PlaidClient.sandboxItemFireWebhook({
      /* eslint-disable camelcase */
      access_token: connectedAccount.token,
      client_id: connectedAccount.clientId,
      webhook_code: webhookCode,
      /* eslint-enable camelcase */
    });

    if (response.data['webhook_fired']) {
      console.log('Webhook fired successfully');
    } else {
      console.error('Failed to fire webhook');
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
