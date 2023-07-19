import '../server/env.js';

import models, { sequelize } from '../server/models/index.js';

async function run() {
  console.log(process.argv);

  if (process.argv.length < 4) {
    console.error('Usage: npm run script ./scripts/update-connected-account-stripe-token.js HOST_ID STRIPE_TOKEN');
    process.exit(1);
  }

  const HOST_ID = process.argv[2];
  const STRIPE_TOKEN = process.argv[3];

  const host = await models.Collective.findByPk(HOST_ID);

  const [stripeAccount] = await host.getConnectedAccounts({
    where: { service: 'stripe' },
  });

  await stripeAccount.update({ token: STRIPE_TOKEN });

  await sequelize.close();
}

run();
