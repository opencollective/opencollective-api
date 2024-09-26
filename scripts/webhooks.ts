import '../server/env';

import { Command } from 'commander';
import config from 'config';
import ngrok from 'ngrok';

import { sequelize } from '../server/models';
import wise from '../server/paymentProviders/transferwise';
const program = new Command();

program.command('dev').action(async () => {
  const url = await ngrok.connect({ proto: 'http', addr: config.port, authtoken: config.ngrok.authtoken });
  if (!url) {
    console.log('Failed to create ngrok tunnel');
  }

  console.log(`Ngrok tunnel created on URL: ${url}`);
  await wise.createWebhooksForHost(url);

  process.on('SIGINT', async () => {
    await wise.removeWebhooksForHost(url);
    await sequelize.close();
    await ngrok.kill();
  });
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/webhooks.ts dev
`,
);

program.parse();
