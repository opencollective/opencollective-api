import { defineRelationMetricSource } from '..';

export const HostedCollectivesMembership = defineRelationMetricSource('HostedCollectivesDailyMembership', {
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
    accountType: { name: 'accountType', column: 'collectiveType', kind: 'enum' },
    event: { name: 'event', column: 'event', kind: 'enum' },
  },
  measures: {
    joinedCount: {
      name: 'joinedCount',
      aggregation: eb => eb.fn.countAll().filterWhere('event', '=', 'JOINED'),
      kind: 'count',
    },
    churnedCount: {
      name: 'churnedCount',
      aggregation: eb => eb.fn.countAll().filterWhere('event', '=', 'CHURNED'),
      kind: 'count',
    },
    joinedDistinctCollectives: {
      name: 'joinedDistinctCollectives',
      aggregation: eb => eb.fn.count('CollectiveId').distinct().filterWhere('event', '=', 'JOINED'),
      kind: 'count',
    },
    churnedDistinctCollectives: {
      name: 'churnedDistinctCollectives',
      aggregation: eb => eb.fn.count('CollectiveId').distinct().filterWhere('event', '=', 'CHURNED'),
      kind: 'count',
    },
  },
});
