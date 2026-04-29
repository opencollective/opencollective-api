import { type GraphQLFieldConfig, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import {
  HostedCollectivesFinancialActivity,
  HostedCollectivesHostingPeriods,
  HostedCollectivesMembership,
} from '../sources';

import { buildSourceField } from './internal/source-builder';

type HostInstance = { id: number };
type HostMetricsParent = { host: HostInstance };

const HostMetricsNamespaceType = new GraphQLObjectType({
  name: 'HostMetricsNamespace',
  description: 'Aggregated metrics for a host',
  fields: () => ({
    hostedCollectivesFinancialActivity: buildSourceField<HostMetricsParent>({
      source: HostedCollectivesFinancialActivity,
      schemaPrefix: 'HostedCollectivesFinancialActivity',
      description: 'Daily per-collective income and spending under the host.',
      bindFromParent: { host: ({ host }) => host.id },
    }),
    hostedCollectivesMembership: buildSourceField<HostMetricsParent>({
      source: HostedCollectivesMembership,
      schemaPrefix: 'HostedCollectivesMembership',
      description: 'Daily join/churn events for hosted collectives.',
      bindFromParent: { host: ({ host }) => host.id },
    }),
    hostedCollectivesHosting: buildSourceField<HostMetricsParent>({
      source: HostedCollectivesHostingPeriods,
      schemaPrefix: 'HostedCollectivesHosting',
      description: 'Distinct collectives hosted by this host in a period.',
      bindFromParent: { host: ({ host }) => host.id },
    }),
  }),
});

export const hostMetricsField: GraphQLFieldConfig<HostInstance, unknown> = {
  type: new GraphQLNonNull(HostMetricsNamespaceType),
  description: 'Aggregated metrics for this host.',
  resolve: host => ({ host }),
};
