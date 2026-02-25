import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

import ManualPaymentProviderModel, { ManualPaymentProviderTypes } from '../../../models/ManualPaymentProvider';
import { GraphQLManualPaymentProviderType } from '../enum/ManualPaymentProviderType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLManualPaymentProvider = new GraphQLObjectType({
  name: 'ManualPaymentProvider',
  description: 'A manual payment provider configured by a host for contributors to use',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this provider',
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${ManualPaymentProviderModel.nanoIdPrefix}_xxxxxxxx)`,
    },
    type: {
      type: new GraphQLNonNull(GraphQLManualPaymentProviderType),
      description: 'The type of manual payment provider',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'Display name for this payment provider',
    },
    instructions: {
      type: GraphQLString,
      description: 'Payment instructions to show contributors (HTML)',
    },
    icon: {
      type: GraphQLString,
      description: 'Icon name for this payment provider',
    },
    accountDetails: {
      type: GraphQLJSON,
      description: 'Bank account details for BANK_TRANSFER type providers',
      resolve: provider => (provider.type === ManualPaymentProviderTypes.BANK_TRANSFER ? provider.data : null),
    },
    isArchived: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this provider has been archived',
      resolve: provider => !!provider.archivedAt,
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'When this provider was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'When this provider was last updated',
    },
  }),
});
