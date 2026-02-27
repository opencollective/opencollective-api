import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';
import { uniq } from 'lodash';
import { Op } from 'sequelize';

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
      type: GraphQLString,
      description: 'The unique identifier of the manual payment provider',
      deprecationReason: '2026-02-25: use publicId',
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
  inputs: { publicId?: string; id?: string }[],
  { loaders, throwIfMissing = false }: { loaders?: Express.Request['loaders']; throwIfMissing?: boolean } = {},
): Promise<ManualPaymentProvider[]> => {
  if (inputs.length === 0) {
    return [];
  }

  const expectedPrefix = models.ManualPaymentProvider.nanoIdPrefix;
  const inputsWithPublicId = inputs.filter(input => input.publicId);
  inputsWithPublicId.forEach(input => {
    if (!input.publicId!.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for ManualPaymentProvider, expected prefix ${expectedPrefix}_`);
    }
  });

  const ids = uniq(
    inputs.filter(input => input.id).map(input => idDecode(input.id!, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER)),
  );
  const publicIds = uniq(inputsWithPublicId.map(input => input.publicId!));

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
    const inputMatchesProvider = (input: { publicId?: string; id?: string }) =>
      providers.some(
        provider =>
          (input.publicId && provider.publicId === input.publicId) ||
          (input.id && provider.id === idDecode(input.id!, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER)),
      );
    const missing = inputs.filter(input => !input.publicId && !input.id);
    if (missing.length > 0) {
      throw new Error('Please provide publicId or id for each input');
    }
    if (!inputs.every(inputMatchesProvider)) {
      const missingRefs = inputs.filter(input => !inputMatchesProvider(input));
      throw new NotFound(
        `Could not find manual payment providers: ${missingRefs.map(i => i.publicId || i.id).join(', ')}`,
      );
    }
  }

  return providers;
};
