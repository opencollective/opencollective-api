import { GraphQLFieldConfig, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { EntityShortIdPrefix, isEntityMigratedToPublicId } from '../../../lib/permalink/entity-map';
import { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import UserTwoFactorMethodModel from '../../../models/UserTwoFactorMethod';
import { GraphQLTwoFactorMethodEnum } from '../enum/TwoFactorMethodEnum';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';

export const UserTwoFactorMethod = new GraphQLObjectType({
  name: 'UserTwoFactorMethod',
  description: 'User two factor authentication method',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: userTwoFactorMethod => {
          if (isEntityMigratedToPublicId(EntityShortIdPrefix.UserTwoFactorMethod, userTwoFactorMethod.createdAt)) {
            return userTwoFactorMethod.publicId;
          } else {
            return idEncode(userTwoFactorMethod.id, IDENTIFIER_TYPES.USER_TWO_FACTOR_METHOD);
          }
        },
      },
      publicId: {
        type: new GraphQLNonNull(GraphQLString),
        description: `The resource public id (ie: ${UserTwoFactorMethodModel.nanoIdPrefix}_xxxxxxxx)`,
      },
      method: {
        type: new GraphQLNonNull(GraphQLTwoFactorMethodEnum),
      },
      name: {
        type: new GraphQLNonNull(GraphQLString),
      },
      createdAt: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
      description: <
        GraphQLFieldConfig<
          UserTwoFactorMethodModel<TwoFactorMethod.TOTP | TwoFactorMethod.YUBIKEY_OTP | TwoFactorMethod.WEBAUTHN>,
          any,
          any
        >
      >{
        type: GraphQLString,
        async resolve(userTwoFactorMethod) {
          if (userTwoFactorMethod.isWebAuthn()) {
            return userTwoFactorMethod.data.description;
          }

          return null;
        },
      },
      icon: <
        GraphQLFieldConfig<
          UserTwoFactorMethodModel<TwoFactorMethod.TOTP | TwoFactorMethod.YUBIKEY_OTP | TwoFactorMethod.WEBAUTHN>,
          any,
          any
        >
      >{
        type: GraphQLString,
        async resolve(userTwoFactorMethod) {
          if (userTwoFactorMethod.isWebAuthn()) {
            return userTwoFactorMethod.data.icon;
          }

          return null;
        },
      },
    };
  },
});
