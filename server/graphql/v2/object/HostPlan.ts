import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

import { idEncode } from '../identifiers.js';

export const GraphQLHostPlan = new GraphQLObjectType({
  name: 'HostPlan',
  description: 'The name of the current plan and its characteristics.',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the account (ie: 5v08jk63-w4g9nbpz-j7qmyder-p7ozax5g)',
      resolve(account) {
        return idEncode(account.id, 'account');
      },
    },
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
      description: 'Whether this plan allows to use the added funds feature',
    },
    addedFundsLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the added funds feature under this plan',
    },
    hostDashboard: {
      type: GraphQLBoolean,
      description: 'Whether this plan allows to use the host dashboard',
    },
    manualPayments: {
      type: GraphQLBoolean,
      description: 'Whether this plan allows to use the manual payments feature',
    },
    bankTransfers: {
      type: GraphQLInt,
      description: 'Whether this plan allows to use the bank transfers feature',
    },
    bankTransfersLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the bank transfers feature under this plan',
    },
    transferwisePayouts: {
      type: GraphQLInt,
      description: 'Whether this plan allows to use the transferwise payouts feature',
    },
    transferwisePayoutsLimit: {
      type: GraphQLInt,
      description: 'Amount limit for the transferwise payouts feature under this plan',
    },
    hostFees: {
      type: GraphQLBoolean,
      description: 'Ability to charge Host Fees.',
    },
    hostFeeSharePercent: {
      type: GraphQLFloat,
      description: 'Charge on revenues made through Host Fees.',
    },
    platformTips: {
      type: GraphQLBoolean,
      description: 'Ability to collect Platform Tips.',
    },
  }),
});
