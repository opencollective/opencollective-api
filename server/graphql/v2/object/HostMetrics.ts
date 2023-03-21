import { GraphQLFloat, GraphQLObjectType } from 'graphql';

import { Amount } from './Amount';

export const HostMetrics = new GraphQLObjectType({
  name: 'HostMetrics',
  description: 'Host metrics related to collected and pending fees/tips.',
  fields: () => ({
    hostFees: { type: Amount, description: 'Amount collected in host fees for given period' },
    platformFees: { type: Amount, description: 'Amount collected in platform fees for given period' },
    pendingPlatformFees: { type: Amount, description: 'Amount collected in platform fees requiring settlement' },
    platformTips: { type: Amount, description: 'Amount collected in platform tips for given period' },
    pendingPlatformTips: { type: Amount, description: 'Amount collected in platform tips requiring settlement' },
    hostFeeShare: { type: Amount, description: 'Amount in host fee shared with the platform' },
    pendingHostFeeShare: { type: Amount, description: 'Amount in host fee shared  requiring settlement' },
    settledHostFeeShare: {
      type: Amount,
      description: 'Amount in host fee shared not requiring settlement',
      deprecationReason: '2023-03-20: Can be calculated with hostFeeShare and pendingHostFeeShare ',
    },
    totalMoneyManaged: { type: Amount, description: 'Total amount managed on behalf of hosted collectives' },
    hostFeeSharePercent: { type: GraphQLFloat, description: 'Host fee sharing percent' },
  }),
});
