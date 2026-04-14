import '../../server/env';

import { sequelize } from '../../server/models';

import { CheckFn, logChecksErrors, runAllChecks } from './_utils';
import { checks as collectivesChecks } from './collectives';
import { checks as deadLocksChecks } from './dead-locks';
import { checks as expensesChecks } from './expenses';
import { checks as hostedCollectivesChecks } from './hosted-collectives';
import { checks as hostsChecks } from './hosts';
import { checks as independentCollectivesChecks } from './independent-collectives';
import { checks as locationsChecks } from './locations';
import { checks as membersChecks } from './members';
import { checks as ordersChecks } from './orders';
import { checks as paymentMethodsChecks } from './payment-methods';
import { checks as tiersChecks } from './tiers';
import { checks as transactionsChecks } from './transactions';
import { checks as usersChecks } from './users';
import { checks as virtualCardsChecks } from './virtual-cards';
import { checks as zeroDecimalCurrenciesChecks } from './zero-decimal-currencies';

const allModelChecks: CheckFn[] = [
  ...collectivesChecks,
  ...locationsChecks,
  ...deadLocksChecks,
  ...expensesChecks,
  ...hostedCollectivesChecks,
  ...hostsChecks,
  ...independentCollectivesChecks,
  ...membersChecks,
  ...ordersChecks,
  ...paymentMethodsChecks,
  ...tiersChecks,
  ...transactionsChecks,
  ...usersChecks,
  ...virtualCardsChecks,
  ...zeroDecimalCurrenciesChecks,
];

export async function checkAllModels({ closeConnection = false }: { closeConnection?: boolean } = {}) {
  const errors = await runAllChecks(allModelChecks);
  logChecksErrors(errors);
  if (closeConnection) {
    await sequelize.close();
  }
  return { errors };
}

if (!module.parent) {
  checkAllModels({ closeConnection: true });
}
