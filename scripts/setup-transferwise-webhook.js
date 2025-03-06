import '../server/env';

import { deleteApplicationWebhook, listApplicationWebhooks } from '../server/lib/transferwise';
import transferwise from '../server/paymentProviders/transferwise';

const run = async () => {
  const action = process.argv?.[2];
  if (action === 'up') {
    console.log('Creating TransferWise app webhook...');
    const webhooks = await transferwise.createWebhooksForHost();
    webhooks.forEach(webhook => {
      console.log(`Webhook created: ${webhook.id} -> ${webhook.trigger_on} ${webhook.delivery.url}`);
    });
  } else if (action === 'list') {
    console.log('Listing app webhooks...');
    const hooks = await listApplicationWebhooks();
    console.log(JSON.stringify(hooks, null, 2));
  } else if (action === 'down') {
    const id = process.argv?.[3];
    if (!id) {
      console.error('Missing id.');
      process.exit(1);
    }
    console.log('Deleting webhook ', id);
    await deleteApplicationWebhook(id);
  } else if (action === 'dev') {
    const url = process.argv?.[3];
    if (!url) {
      console.error('Missing url.');
      process.exit(1);
    }
    console.log('Creating TransferWise app webhook for dev...');
    const webhooks = await transferwise.createWebhooksForHost(url);
    webhooks.forEach(webhook => {
      console.log(`Webhook created: ${webhook.id} -> ${webhook.trigger_on} ${webhook.delivery.url}`);
    });

    console.log('Webhooks created, awaiting for SIGINT (Ctrl + C) to delete them..');
    process.stdin.resume();
    process.on('SIGINT', async () => {
      await Promise.all(
        webhooks.map(webhook => {
          console.log(`Deleting webhook ${webhook.id} -> ${webhook.trigger_on} ${webhook.delivery.url}`);
          return deleteApplicationWebhook(webhook.id);
        }),
      );
      process.exit();
    });
    return;
  } else {
    console.log('Usage: npm run script scripts/setup-transferwise-webhook.js [up|list|down] [id]');
    process.exit();
  }

  console.log('Done.');
  process.exit();
};

run();
