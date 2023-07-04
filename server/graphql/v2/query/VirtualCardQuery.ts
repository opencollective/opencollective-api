import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import VirtualCard from '../../../models/VirtualCard';
import { checkScope } from '../../common/scope-check';
import { NotFound } from '../../errors';
import { GraphQLVirtualCardReferenceInput } from '../input/VirtualCardReferenceInput';
import { GraphQLVirtualCard } from '../object/VirtualCard';

const VirtualCardQuery = {
  type: GraphQLVirtualCard,
  args: {
    virtualCard: {
      type: new GraphQLNonNull(GraphQLVirtualCardReferenceInput),
      description: 'Identifiers to retrieve the virtual card',
    },
    throwIfMissing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If true, an error will be returned if the virtual card is missing',
      defaultValue: true,
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<VirtualCard | null> {
    if (!checkScope(req, 'virtualCards')) {
      return null;
    }

    const virtualCard = await VirtualCard.findByPk(args.virtualCard.id, {
      include: ['collective', 'host', 'user'],
    });

    if (!virtualCard && args.throwIfMissing) {
      throw new NotFound('Virtual Card Not Found');
    }

    if (
      !req.remoteUser?.isAdminOfCollective(virtualCard.collective) &&
      !req.remoteUser?.isAdminOfCollective(virtualCard.host) &&
      req?.remoteUser?.id !== virtualCard.UserId
    ) {
      return null;
    }

    return virtualCard;
  },
};

export default VirtualCardQuery;
