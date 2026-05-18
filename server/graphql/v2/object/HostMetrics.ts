import { GraphQLFloat, GraphQLObjectType } from 'graphql';

import { GraphQLAmount } from './Amount';

// All fields on this type are deprecated: `Host.hostMetrics` itself is deprecated
// (2025-06-24) and as of 2026-05-15 no frontend consumer queries any field on it.
// The backing `Collective.getHostMetrics` method returns zeros for every value so each
// field below still resolves but no longer reflects ledger state. Use `Host.hostStats`
// or query transactions directly for live numbers.
const DEPRECATION = '2026-05-15: Host.hostMetrics is deprecated and unused by the frontend; this field is always 0.';

export const GraphQLHostMetrics = new GraphQLObjectType({
  name: 'HostMetrics',
  description: 'Host metrics related to collected and pending fees/tips.',
  fields: () => ({
    hostFees: {
      type: GraphQLAmount,
      description: 'Amount collected in host fees for given period',
      deprecationReason: DEPRECATION,
    },
    platformFees: {
      type: GraphQLAmount,
      description: 'Amount collected in platform fees for given period',
      deprecationReason: DEPRECATION,
    },
    pendingPlatformFees: {
      type: GraphQLAmount,
      description: 'Amount collected in platform fees requiring settlement',
      deprecationReason: DEPRECATION,
    },
    platformTips: {
      type: GraphQLAmount,
      description: 'Amount collected in platform tips for given period',
      deprecationReason: DEPRECATION,
    },
    pendingPlatformTips: {
      type: GraphQLAmount,
      description: 'Amount collected in platform tips requiring settlement',
      deprecationReason: DEPRECATION,
    },
    hostFeeShare: {
      type: GraphQLAmount,
      description: 'Amount in host fee shared with the platform',
      deprecationReason: DEPRECATION,
    },
    pendingHostFeeShare: {
      type: GraphQLAmount,
      description: 'Amount in host fee shared  requiring settlement',
      deprecationReason: DEPRECATION,
    },
    settledHostFeeShare: {
      type: GraphQLAmount,
      description: 'Amount in host fee shared not requiring settlement',
      deprecationReason: DEPRECATION,
    },
    totalMoneyManaged: {
      type: GraphQLAmount,
      description: 'Total amount managed on behalf of hosted collectives',
      deprecationReason: DEPRECATION,
    },
    hostFeeSharePercent: {
      type: GraphQLFloat,
      description: 'Host fee sharing percent',
      deprecationReason: DEPRECATION,
    },
  }),
});
