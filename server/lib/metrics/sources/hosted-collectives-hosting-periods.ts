import { sql } from 'kysely';

import { defineRelationMetricSource } from '..';

export const HostedCollectivesHostingPeriods = defineRelationMetricSource('HostedCollectivesHostingPeriods', {
  kind: 'range',
  startColumn: 'startDate',
  endColumn: 'endDate',
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
    accountType: { name: 'accountType', column: 'collectiveType', kind: 'enum' },
    // The view filters `c.ParentCollectiveId IS NULL`, so every row is a root —
    // mainAccountType is just an alias for accountType. Exposed under the same
    // name as the financial-activity source so callers can use a single filter
    // key across both sources without remembering which is which.
    mainAccountType: { name: 'mainAccountType', column: 'collectiveType', kind: 'enum' },
    endDate: { name: 'endDate', column: 'endDate', kind: 'date', nullable: true },
  },
  measures: {
    hostedCollectives: {
      name: 'hostedCollectives',
      aggregation: eb => eb.fn.count('CollectiveId').distinct(),
      kind: 'count',
    },
    daysHostedToDate: {
      name: 'daysHostedToDate',
      aggregation: eb => sql`MAX(CURRENT_DATE - ${eb.ref('startDate')})`,
      kind: 'number',
    },
  },
});
