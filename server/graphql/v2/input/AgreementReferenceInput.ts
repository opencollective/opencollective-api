import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import Agreement from '../../../models/Agreement';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLAgreementReferenceInput = new GraphQLInputObjectType({
  name: 'AgreementReferenceInput',
  fields: () => ({
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
    id?: string;
    legacyId?: number;
  },
  opts?: { throwIfMissing?: boolean },
) => {
  if (!input.id && !input.legacyId) {
    throw new Error('Please provide an id or a legacyId');
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
