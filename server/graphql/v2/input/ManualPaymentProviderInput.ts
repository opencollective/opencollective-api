import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';
import { uniq } from 'lodash';

import models from '../../../models';
import ManualPaymentProvider from '../../../models/ManualPaymentProvider';
import { NotFound } from '../../errors';
import { GraphQLManualPaymentProviderType } from '../enum/ManualPaymentProviderType';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * Input type for referencing an existing ManualPaymentProvider
 */
export const GraphQLManualPaymentProviderReferenceInput = new GraphQLInputObjectType({
  name: 'ManualPaymentProviderReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.ManualPaymentProvider.nanoIdPrefix}_xxxxxxxx)`,
    },
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
  input: { publicId?: string; id?: string },
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider | null> => {
  let provider: ManualPaymentProvider | null = null;
  if (input.publicId) {
    const expectedPrefix = models.ManualPaymentProvider.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for ManualPaymentProvider, expected prefix ${expectedPrefix}_`);
    }

    provider = await models.ManualPaymentProvider.findOne({ where: { publicId: input.publicId } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER);

    if (loaders) {
      provider = await loaders.ManualPaymentProvider.byId.load(id);
    } else {
      provider = await models.ManualPaymentProvider.findByPk(id);
    }
  }

  if (!provider && throwIfMissing) {
    throw new NotFound('Manual Payment Provider Not Found');
  }

  return provider;
};

export const fetchManualPaymentProvidersWithReferences = async (
  inputs: { id: string }[],
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider[]> => {
  let providers: ManualPaymentProvider[] = [];
  const ids = inputs.map(input => idDecode(input.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER));
  const uniqueIds = uniq(ids);
  if (loaders) {
    const loaded = await loaders.ManualPaymentProvider.byId.loadMany(uniqueIds);
    providers = loaded.filter(provider => provider instanceof ManualPaymentProvider);
  } else {
    providers = await models.ManualPaymentProvider.findAll({ where: { id: uniqueIds } });
  }

  if (throwIfMissing && providers.length !== uniqueIds.length) {
    const missingIds = uniqueIds.filter(id => !providers.find(provider => provider.id === id));
    throw new NotFound(`Could not find manual payment providers with ids: ${missingIds.join(', ')}`);
  }

  return providers;
};
