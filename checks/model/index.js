import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';
import { checkCollectives } from './collectives';
import { checkHostedCollectives } from './hosted-collectives';
import { checkHosts } from './hosts';
import { checkIndependentCollectives } from './independent-collectives';
import { checkMembers } from './members';
import { checkPaymentMethods } from './payment-methods';
import { checkTransactions } from './transactions';
import { checkUsers } from './users';
import { checkVirtualCards } from './virtual-cards';

const allModelChecks = [
  checkCollectives,
  checkHosts,
  checkHostedCollectives,
  checkIndependentCollectives,
  checkMembers,
  checkPaymentMethods,
  checkTransactions,
  checkUsers,
  checkVirtualCards,
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
  runCheckThenExit(checkAllModels);
}
