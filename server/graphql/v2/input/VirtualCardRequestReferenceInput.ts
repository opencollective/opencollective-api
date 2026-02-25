import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import VirtualCardRequest from '../../../models/VirtualCardRequest';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLVirtualCardRequestReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardRequestReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${VirtualCardRequest.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: { type: GraphQLString },
    legacyId: { type: GraphQLInt },
  }),
});

export async function fetchVirtualCardRequestWithReference(input, { include = null, throwIfMissing = false } = {}) {
  const loadVirtualCardRequestById = id => {
    return VirtualCardRequest.findByPk(id, { include });
  };

  let virtualCardRequest: VirtualCardRequest;
  if (input.publicId) {
    const expectedPrefix = VirtualCardRequest.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for VirtualCardRequest, expected prefix ${expectedPrefix}_`);
    }

    virtualCardRequest = await VirtualCardRequest.findOne({ where: { publicId: input.publicId }, include });
  } else if (input.id) {
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
