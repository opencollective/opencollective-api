import { expect } from 'chai';

import { sequelize } from '../../../server/models';

const indexMatcher = (tablename, indexExpression) => indexes =>
  indexes.some(i => i.tablename === tablename && i.indexdef.includes(indexExpression));

describe('test/cron/hourly/50-refresh-materialized-views.test.ts', () => {
  it('should have all the required indexes created beforehand', async () => {
    const [indexes] = await sequelize.query(`select * from pg_indexes where schemaname = 'public'`);

    expect(indexes).to.satisfy(
      indexMatcher('CollectiveTransactionStats', 'ON public."CollectiveTransactionStats" USING btree (id)'),
    );
    expect(indexes).to.satisfy(
      indexMatcher('CollectiveOrderStats', 'ON public."CollectiveOrderStats" USING btree ("CollectiveId")'),
    );
  });
});
