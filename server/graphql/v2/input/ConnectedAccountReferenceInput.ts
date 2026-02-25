import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models, { ConnectedAccount } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing ConnectedAccounts.
 */
export const GraphQLConnectedAccountReferenceInput = new GraphQLInputObjectType({
  name: 'ConnectedAccountReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.ConnectedAccount.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the connected account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
      deprecationReason: '2026-02-25: use publicId',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the account (ie: 580)',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

export const fetchConnectedAccountWithReference = async (
  input,
  { throwIfMissing } = { throwIfMissing: false },
): Promise<ConnectedAccount> => {
  let connectedAccount;
  if (input.publicId) {
    const expectedPrefix = models.ConnectedAccount.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for ConnectedAccount, expected prefix ${expectedPrefix}_`);
    }

    connectedAccount = await models.ConnectedAccount.findOne({ where: { publicId: input.publicId } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.CONNECTED_ACCOUNT);
    connectedAccount = await models.ConnectedAccount.findByPk(id);
  } else if (input.legacyId) {
    connectedAccount = await models.ConnectedAccount.findByPk(input.legacyId);
  } else {
    throw new Error('Please provide an id or a legacyId');
  }
  if (!connectedAccount && throwIfMissing) {
    throw new NotFound('ConnectedAccount Not Found');
  }
  return connectedAccount;
};
