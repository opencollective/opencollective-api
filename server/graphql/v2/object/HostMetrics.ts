import { GraphQLFloat, GraphQLObjectType } from 'graphql';

import { GraphQLAmount } from './Amount';

export const GraphQLHostMetrics = new GraphQLObjectType({
  name: 'HostMetrics',
  description: 'Host metrics related to collected and pending fees/tips.',
  fields: () => ({
    hostFees: { type: GraphQLAmount, description: 'Amount collected in host fees for given period' },
    platformFees: { type: GraphQLAmount, description: 'Amount collected in platform fees for given period' },
    pendingPlatformFees: { type: GraphQLAmount, description: 'Amount collected in platform fees requiring settlement' },
    platformTips: { type: GraphQLAmount, description: 'Amount collected in platform tips for given period' },
    pendingPlatformTips: { type: GraphQLAmount, description: 'Amount collected in platform tips requiring settlement' },
    hostFeeShare: { type: GraphQLAmount, description: 'Amount in host fee shared with the platform' },
    pendingHostFeeShare: { type: GraphQLAmount, description: 'Amount in host fee shared  requiring settlement' },
    settledHostFeeShare: { type: GraphQLAmount, description: 'Amount in host fee shared not requiring settlement' },
    totalMoneyManaged: { type: GraphQLAmount, description: 'Total amount managed on behalf of hosted collectives' },
    hostFeeSharePercent: { type: GraphQLFloat, description: 'Host fee sharing percent' },
  }),
});
