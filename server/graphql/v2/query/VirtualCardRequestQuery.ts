import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import VirtualCardRequest from '../../../models/VirtualCardRequest';
import { checkScope } from '../../common/scope-check';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLVirtualCardRequestReferenceInput } from '../input/VirtualCardRequestReferenceInput';
import { GraphQLVirtualCardRequest } from '../object/VirtualCardRequest';

const VirtualCardRequestQuery = {
  type: GraphQLVirtualCardRequest,
  args: {
    virtualCardRequest: {
      type: new GraphQLNonNull(GraphQLVirtualCardRequestReferenceInput),
      description: 'Identifiers to retrieve the virtual card request',
    },
    throwIfMissing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If true, an error will be returned if the virtual card request is missing',
      defaultValue: true,
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<VirtualCardRequest | null> {
    if (!checkScope(req, 'virtualCards')) {
      return null;
    }

    const legacyId = idDecode(args.virtualCardRequest.id, IDENTIFIER_TYPES.VIRTUAL_CARD_REQUEST);

    const virtualCardRequest = await VirtualCardRequest.findByPk(legacyId, {
      include: ['collective', 'host'],
    });

    if (!virtualCardRequest && args.throwIfMissing) {
      throw new NotFound('Virtual Card Request Not Found');
    }

    if (
      !req.remoteUser?.isAdminOfCollective(virtualCardRequest.collective) &&
      !req.remoteUser?.isAdminOfCollective(virtualCardRequest.host) &&
      req?.remoteUser?.id !== virtualCardRequest.UserId
    ) {
      return null;
    }

    return virtualCardRequest;
  },
};

export default VirtualCardRequestQuery;
