import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import VirtualCardRequest from '../../../models/VirtualCardRequest';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLVirtualCardRequestReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardRequestReferenceInput',
  fields: () => ({
    id: { type: GraphQLString },
    legacyId: { type: GraphQLInt },
  }),
});

export async function fetchVirtualCardRequestWithReference(input, { include = null, throwIfMissing = false } = {}) {
  const loadVirtualCardRequestById = id => {
    return VirtualCardRequest.findByPk(id, { include });
  };

  let virtualCardRequest: VirtualCardRequest;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.VIRTUAL_CARD_REQUEST);
    virtualCardRequest = await loadVirtualCardRequestById(id);
  } else if (input.legacyId) {
    virtualCardRequest = await loadVirtualCardRequestById(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!virtualCardRequest && throwIfMissing) {
    throw new NotFound('Virtual Card Request Not Found');
  }
  return virtualCardRequest;
}
