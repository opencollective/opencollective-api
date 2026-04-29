import { sql } from 'kysely';

import { defineRelationMetricSource } from '..';

export const HostedCollectivesFinancialActivity = defineRelationMetricSource(
  'HostedCollectivesDailyFinancialActivity',
  {
    kind: 'dense',
    dateColumn: 'day',
    dimensions: {
      host: {
        name: 'host',
        column: 'HostCollectiveId',
        kind: 'account',
      },
      account: {
        name: 'account',
        column: 'CollectiveId',
        kind: 'account',
      },
      parent: {
        name: 'parent',
        column: 'ParentCollectiveId',
        kind: 'account',
        nullable: true,
      },
      mainAccount: {
        name: 'mainAccount',
        expression: eb => eb.fn.coalesce('ParentCollectiveId', 'CollectiveId'),
        kind: 'account',
      },
      isMainAccount: {
        name: 'isMainAccount',
        expression: eb => eb('ParentCollectiveId', 'is', null),
        kind: 'boolean',
      },
      accountType: { name: 'accountType', column: 'collectiveType', kind: 'enum' },
      // Type of the rolled-up main account: parent's type when the row is a child
      // (event/project), else the row's own type. Use this — not `accountType` —
      // to filter "FUND activity (including child PROJECTs)" without sweeping in
      // PROJECTs whose parent is a COLLECTIVE.
      mainAccountType: { name: 'mainAccountType', column: 'mainAccountType', kind: 'enum' },
      hostCurrency: { name: 'hostCurrency', column: 'hostCurrency', kind: 'string' },
    },
    measures: {
      incomeAmount: {
        name: 'incomeAmount',
        aggregation: eb => eb.fn.sum<bigint>('incomeAmount'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description: 'Net contributions and added funds, in host currency',
      },
      spendingAmount: {
        name: 'spendingAmount',
        aggregation: eb => eb.fn.sum<bigint>('spendingAmount'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description: 'Net expenses paid out, in host currency',
      },
      transactionCount: {
        name: 'transactionCount',
        aggregation: eb => eb.fn.sum<number>('transactionCount'),
        kind: 'count',
      },
      activeCollectives: {
        name: 'activeCollectives',
        aggregation: eb => eb.fn.count(eb.fn.coalesce('ParentCollectiveId', 'CollectiveId')).distinct(),
        kind: 'count',
      },
      daysSinceLastActivity: {
        name: 'daysSinceLastActivity',
        aggregation: eb => sql`(CURRENT_DATE - ${eb.fn.max('day')})`,
        kind: 'number',
      },
    },
  },
);
