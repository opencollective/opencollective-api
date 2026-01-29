import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

import models from '../../../models';
import type ManualPaymentProvider from '../../../models/ManualPaymentProvider';
import { NotFound } from '../../errors';
import { GraphQLManualPaymentProviderType } from '../enum/ManualPaymentProviderType';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * Input type for referencing an existing ManualPaymentProvider
 */
export const GraphQLManualPaymentProviderReferenceInput = new GraphQLInputObjectType({
  name: 'ManualPaymentProviderReferenceInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The unique identifier of the manual payment provider',
    },
  }),
});

/**
 * Input type for creating a new ManualPaymentProvider
 */
export const GraphQLManualPaymentProviderCreateInput = new GraphQLInputObjectType({
  name: 'ManualPaymentProviderCreateInput',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLManualPaymentProviderType),
      description: 'The type of manual payment provider',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'Display name for this payment provider',
    },
    instructions: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Payment instructions to show contributors (HTML allowed)',
    },
    icon: {
      type: GraphQLString,
      description: 'Icon name for this payment provider',
    },
    accountDetails: {
      type: GraphQLJSON,
      description: 'Bank account details for BANK_TRANSFER type providers',
    },
  }),
});

/**
 * Input type for updating an existing ManualPaymentProvider
 */
export const GraphQLManualPaymentProviderUpdateInput = new GraphQLInputObjectType({
  name: 'ManualPaymentProviderUpdateInput',
  fields: () => ({
    name: {
      type: GraphQLNonEmptyString,
      description: 'Display name for this payment provider',
    },
    instructions: {
      type: GraphQLString,
      description: 'Payment instructions to show contributors (HTML allowed)',
    },
    icon: {
      type: GraphQLString,
      description: 'Icon name for this payment provider',
    },
    accountDetails: {
      type: GraphQLJSON,
      description: 'Bank account details for BANK_TRANSFER type providers',
    },
  }),
});

/**
 * Retrieves a ManualPaymentProvider by reference
 */
export const fetchManualPaymentProviderWithReference = async (
  input: { id: string },
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider | null> => {
  const id = idDecode(input.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER);

  let provider: ManualPaymentProvider | null = null;
  if (loaders) {
    provider = await loaders.ManualPaymentProvider.byId.load(id);
  } else {
    provider = await models.ManualPaymentProvider.findByPk(id);
  }

  if (!provider && throwIfMissing) {
    throw new NotFound('Manual Payment Provider Not Found');
  }

  return provider;
};
