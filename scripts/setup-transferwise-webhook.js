import '../server/env';

import { deleteApplicationWebhook, listApplicationWebhooks } from '../server/lib/transferwise';
import transferwise from '../server/paymentProviders/transferwise';

const run = async () => {
  const action = process.argv?.[2];
  if (action === 'up') {
    console.log('Creating TransferWise app webhook...');
    const webhook = await transferwise.setUpWebhook();
    console.log(`Webhook created: ${webhook.id} -> ${webhook.delivery.url}`);
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
  } else {
    console.log('Usage: npm run script scripts/setup-transferwise-webhook.js [up|list|down] [id]');
    process.exit();
  }

  console.log('Done.');
  process.exit();
};

run();
