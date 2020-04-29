import { GraphQLBoolean, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

export const HostPlan = new GraphQLObjectType({
  name: 'HostPlan',
  description: 'The name of the current plan and its characteristics.',
  fields: {
    name: {
      type: GraphQLString,
      description: 'The name of the plan',
    },
    hostedCollectives: {
      type: GraphQLInt,
      description: 'Number of collectives hosted',
    },
    hostedCollectivesLimit: {
      type: GraphQLInt,
      description: 'Max number of collectives than can be hosted',
    },
    addedFunds: {
      type: GraphQLInt,
      description: 'Wether this plan allows to use the added funds feature',
    },
    addedFundsLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the added funds feature under this plan',
    },
    hostDashboard: {
      type: GraphQLBoolean,
      description: 'Wether this plan allows to use the host dashboard',
    },
    manualPayments: {
      type: GraphQLBoolean,
      description: 'Wether this plan allows to use the manual payments feature',
    },
    bankTransfers: {
      type: GraphQLInt,
      description: 'Wether this plan allows to use the bank transfers feature',
    },
    bankTransfersLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the bank transfers feature under this plan',
    },
    transferwisePayouts: {
      type: GraphQLInt,
      description: 'Wether this plan allows to use the transferwise payouts feature',
    },
    transferwisePayoutsLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the transferwise payouts feature under this plan',
    },
  },
});
