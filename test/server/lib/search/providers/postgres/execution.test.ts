import { expect } from 'chai';
import config from 'config';
import { sql } from 'kysely';
import { times } from 'lodash';

import {
  runWithSearchBudget,
  SearchBudgetExceeded,
} from '../../../../../../server/lib/search/providers/postgres/execution';
import { sequelize } from '../../../../../../server/models';

const sleep = (seconds: number) => sql`SELECT pg_sleep(${seconds})`;

const expectBudgetExceeded = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(SearchBudgetExceeded);
    return;
  }

  expect.fail('Expected the search budget to be exceeded');
};

describe('server/lib/search/providers/postgres/execution', () => {
  describe('runWithSearchBudget', () => {
    it('cancels a later statement once the deadline of the whole transaction is reached', async () => {
      const start = Date.now();
      // Each statement alone fits in the budget, both together don't
      await expectBudgetExceeded(
        runWithSearchBudget({ deadline: start + 600 }, async (trx, budget) => {
          await budget.renewStatementTimeout();
          await sleep(0.4).execute(trx);
          await budget.renewStatementTimeout();
          await sleep(0.4).execute(trx);
        }),
      );

      expect(Date.now() - start).to.be.below(750);
    });

    it('does not wait for a pooled connection after the deadline', async () => {
      // Take every connection of the pool (the pool waits up to `acquire` for one, 20 minutes by default)
      const poolSize = Number(config.database.options.pool.max);
      const transactions = await Promise.all(times(poolSize, () => sequelize.transaction()));
      try {
        const start = Date.now();
        await expectBudgetExceeded(runWithSearchBudget({ deadline: start + 300 }, async () => 'never'));
        expect(Date.now() - start).to.be.below(1000);
      } finally {
        await Promise.all(transactions.map(transaction => transaction.rollback()));
      }

      // The pool is usable again once the connections are released
      expect(await runWithSearchBudget({ deadline: Date.now() + 5000 }, async () => 'ok')).to.eq('ok');
    });
  });
});
