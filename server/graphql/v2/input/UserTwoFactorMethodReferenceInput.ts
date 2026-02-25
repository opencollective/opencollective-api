import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLUserTwoFactorMethodReferenceInput = new GraphQLInputObjectType({
  name: 'UserTwoFactorMethodReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${UserTwoFactorMethod.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: { type: GraphQLString },
    legacyId: { type: GraphQLInt },
  }),
});

export async function fetchUserTwoFactorMethodWithReference(input, { include = null, throwIfMissing = false } = {}) {
  const loadUserTwoFactorMethodById = id => {
    return UserTwoFactorMethod.findByPk(id, { include });
  };

  let userTwoFactorMethod: UserTwoFactorMethod<Exclude<TwoFactorMethod, TwoFactorMethod.RECOVERY_CODE>>;
  if (input.publicId) {
    const expectedPrefix = UserTwoFactorMethod.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for UserTwoFactorMethod, expected prefix ${expectedPrefix}_`);
    }

    userTwoFactorMethod = await UserTwoFactorMethod.findOne({ where: { publicId: input.publicId }, include });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.USER_TWO_FACTOR_METHOD);
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
