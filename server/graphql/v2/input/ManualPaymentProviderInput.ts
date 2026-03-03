import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';
import { partition, uniq } from 'lodash';
import { Op } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
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
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The unique identifier of the manual payment provider (ie: ${EntityShortIdPrefix.ManualPaymentProvider}_xxxxxxxx)`,
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
  input: { id?: string },
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider | null> => {
  let provider: ManualPaymentProvider | null = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.ManualPaymentProvider)) {
    provider = await models.ManualPaymentProvider.findOne({ where: { publicId: input.id } });
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
  inputs: { id?: string }[],
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider[]> => {
  if (inputs.length === 0) {
    return [];
  }

  const [inputsWithPublicId, inputsWithoutPublicId] = partition(inputs, input =>
    isEntityPublicId(input.id, EntityShortIdPrefix.ManualPaymentProvider),
  );

  const ids = uniq(inputsWithoutPublicId.map(input => idDecode(input.id!, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER)));
  const publicIds = uniq(inputsWithPublicId.map(input => input.id!));

  const where: { id?: number[]; publicId?: string[]; [Op.or]?: Array<{ id: number[] } | { publicId: string[] }> } = {};
  if (ids.length > 0 && publicIds.length > 0) {
    where[Op.or] = [{ id: ids }, { publicId: publicIds }];
  } else if (ids.length > 0) {
    where.id = ids;
  } else if (publicIds.length > 0) {
    where.publicId = publicIds;
  }

  let providers: ManualPaymentProvider[] = [];
  if (loaders && ids.length > 0 && publicIds.length === 0) {
    const loaded = await loaders.ManualPaymentProvider.byId.loadMany(ids);
    providers = loaded.filter((p): p is ManualPaymentProvider => p instanceof ManualPaymentProvider);
  } else if (Object.keys(where).length > 0) {
    providers = await models.ManualPaymentProvider.findAll({ where });
  }

  if (throwIfMissing) {
    const inputMatchesProvider = (input: { id?: string }) =>
      providers.some(
        provider =>
          (isEntityPublicId(input.id, EntityShortIdPrefix.ManualPaymentProvider) && provider.publicId === input.id) ||
          (input.id && provider.id === idDecode(input.id!, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER)),
      );
    const missing = inputs.filter(input => !input.id);
    if (missing.length > 0) {
      throw new Error('Please provide id for each input');
    }
    if (!inputs.every(inputMatchesProvider)) {
      const missingRefs = inputs.filter(input => !inputMatchesProvider(input));
      throw new NotFound(`Could not find manual payment providers: ${missingRefs.map(i => i.id).join(', ')}`);
    }
  }

  return providers;
};
