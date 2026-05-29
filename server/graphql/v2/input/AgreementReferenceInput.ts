import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import Agreement from '../../../models/Agreement';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLAgreementReferenceInput = new GraphQLInputObjectType({
  name: 'AgreementReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the agreement (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${Agreement.nanoIdPrefix}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the agreement (ie: 580)',
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

export const fetchAgreementWithReference = async (
  input: {
    id: string;
    legacyId?: number;
  },
  opts?: { loaders?: Loaders; throwIfMissing?: boolean },
) => {
  if (!input.id && !input.legacyId) {
    throw new Error('Please provide a id or a legacyId');
  }

  if (isEntityPublicId(input.id, EntityShortIdPrefix.Agreement)) {
    const agreement = await (opts?.loaders
      ? opts.loaders.Agreement.byPublicId.load(input.id)
      : Agreement.findOne({ where: { publicId: input.id } }));
    if (agreement) {
      return agreement;
    }

    if (opts?.throwIfMissing) {
      throw new NotFound('Agreement Not Found');
    }

    return null;
  }

  const legacyId = input.legacyId || idDecode(input.id, IDENTIFIER_TYPES.AGREEMENT);
  const agreement = await Agreement.findByPk(legacyId);
  if (agreement) {
    return agreement;
  }

  if (opts?.throwIfMissing) {
    throw new NotFound('Agreement Not Found');
  }
  return null;
};
