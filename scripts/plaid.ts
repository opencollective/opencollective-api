import '../server/env';

import { Command } from 'commander';
import config from 'config';

import { getPlaidClient } from '../server/lib/plaid/client';
import { syncPlaidAccount } from '../server/lib/plaid/sync';
import { ConnectedAccount } from '../server/models';

const program = new Command();

program
  .command('sync')
  .argument('<id>', 'ID of the connected account to sync')
  .description('Sync a connected Plaid account')
  .option('-f, --full', 'Sync all transactions, not just new ones')
  .action(async (id, options) => {
    const connectedAccount = await ConnectedAccount.findByPk(id);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${id} not found`);
    }

    await syncPlaidAccount(connectedAccount, { log: true, full: options.full });
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
  .argument('<webhookCode>', 'Webhook code to fire')
  .description('[Sandbox only] Fire a Plaid webhook event')
  .action(async (connectedAccountId, webhookCode) => {
    throwIfNotSandbox();

    const connectedAccount = await ConnectedAccount.findByPk(connectedAccountId);
    if (!connectedAccount) {
      throw new Error(`Connected account with ID ${connectedAccountId} not found`);
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
