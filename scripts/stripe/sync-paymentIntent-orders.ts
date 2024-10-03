import '../../server/env';

import { compact, toNumber } from 'lodash';

import logger from '../../server/lib/logger';
import { syncOrder } from '../../server/lib/stripe/sync-order';
import models from '../../server/models';

const main = async () => {
  const transactionIds = compact(process.argv.slice(2).map(toNumber));
  for (const id of transactionIds) {
    const order = await models.Order.findByPk(id, {
      include: [{ model: models.Collective, as: 'collective' }],
    });
    await syncOrder(order, { IS_DRY: process.env.DRY, logging: logger.info });
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
