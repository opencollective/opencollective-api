import '../server/env';

import { checkCollectives } from './collectives';
import { checkHosts } from './hosts';
import { checkIndepedentCollectives } from './independent-collectives';
import { checkTransactions } from './transactions';
import { checkUsers } from './users';

export async function checkAll() {
  await checkCollectives();
  await checkHosts();
  await checkIndepedentCollectives();
  await checkTransactions();
  await checkUsers();
  process.exit();
}

if (!module.parent) {
  checkAll();
}
