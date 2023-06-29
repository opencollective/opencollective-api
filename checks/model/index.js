import '../../server/env';

import { parseArgs } from 'node:util';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { checkCollectives } from './collectives';
import { checkHostedCollectives } from './hosted-collectives';
import { checkHosts } from './hosts';
import { checkIndepedentCollectives } from './independent-collectives';
import { checkTransactions } from './transactions';
import { checkUsers } from './users';

const allModelChecks = [
  checkCollectives,
  checkHosts,
  checkHostedCollectives,
  checkIndepedentCollectives,
  checkTransactions,
  checkUsers,
];

export async function checkAllModels({ fix = false } = {}) {
  const errors = [];

  for (const check of allModelChecks) {
    try {
      await check({ fix });
    } catch (e) {
      logger.error(e.message);
      errors.push(e.message);
    }
  }

  await sequelize.close();

  return { errors };
}

if (!module.parent) {
  const options = {
    fix: {
      type: 'boolean',
      default: false,
    },
  };

  const {
    values: { fix },
  } = parseArgs({ options });

  checkAllModels({ fix });

  process.exit();
}
