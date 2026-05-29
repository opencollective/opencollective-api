import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLUserTwoFactorMethodReferenceInput = new GraphQLInputObjectType({
  name: 'UserTwoFactorMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the user two factor method (ie: ${UserTwoFactorMethod.nanoIdPrefix}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

export async function fetchUserTwoFactorMethodWithReference(input, { include = null, throwIfMissing = false } = {}) {
  const loadUserTwoFactorMethodById = id => {
    return UserTwoFactorMethod.findByPk(id, { include });
  };

  let userTwoFactorMethod: UserTwoFactorMethod<Exclude<TwoFactorMethod, TwoFactorMethod.RECOVERY_CODE>>;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.UserTwoFactorMethod)) {
    userTwoFactorMethod = await UserTwoFactorMethod.findOne({ where: { publicId: input.id }, include });
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
