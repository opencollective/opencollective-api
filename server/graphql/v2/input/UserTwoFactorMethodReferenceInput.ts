import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLUserTwoFactorMethodReferenceInput = new GraphQLInputObjectType({
  name: 'UserTwoFactorMethodReferenceInput',
  fields: () => ({
    id: { type: GraphQLString },
    legacyId: { type: GraphQLInt },
  }),
});

export async function fetchUserTwoFactorMethodWithReference(input, { include = null, throwIfMissing = false } = {}) {
  const loadUserTwoFactorMethodById = id => {
    return UserTwoFactorMethod.findByPk(id, { include });
  };

  let userTwoFactorMethod: UserTwoFactorMethod<Exclude<TwoFactorMethod, TwoFactorMethod.RECOVERY_CODE>>;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.VIRTUAL_CARD_REQUEST);
    userTwoFactorMethod = await loadUserTwoFactorMethodById(id);
  } else if (input.legacyId) {
    userTwoFactorMethod = await loadUserTwoFactorMethodById(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!userTwoFactorMethod && throwIfMissing) {
    throw new NotFound('User Two Factor Method Not Found');
  }
  return userTwoFactorMethod;
}
