import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import Agreement from '../../../models/Agreement';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLAgreementReferenceInput = new GraphQLInputObjectType({
  name: 'AgreementReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${Agreement.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the agreement (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the agreement (ie: 580)',
    },
  }),
});

export const fetchAgreementWithReference = async (
  input: {
    publicId?: string;
    id?: string;
    legacyId?: number;
  },
  opts?: { throwIfMissing?: boolean },
) => {
  if (!input.publicId && !input.id && !input.legacyId) {
    throw new Error('Please provide a publicId, id or a legacyId');
  }

  if (input.publicId) {
    const expectedPrefix = Agreement.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Agreement, expected prefix ${expectedPrefix}_`);
    }

    const agreement = await Agreement.findOne({ where: { publicId: input.publicId } });
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
