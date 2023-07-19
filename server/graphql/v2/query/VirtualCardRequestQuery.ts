import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import VirtualCardRequest from '../../../models/VirtualCardRequest.js';
import { checkScope } from '../../common/scope-check.js';
import {
  fetchVirtualCardRequestWithReference,
  GraphQLVirtualCardRequestReferenceInput,
} from '../input/VirtualCardRequestReferenceInput.js';
import { GraphQLVirtualCardRequest } from '../object/VirtualCardRequest.js';

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

    const virtualCardRequest = await fetchVirtualCardRequestWithReference(args.virtualCardRequest, {
      include: ['collective', 'host'],
      throwIfMissing: args.throwIfMissing,
    });

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
