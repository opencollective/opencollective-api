import { GraphQLFieldConfig, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import UserTwoFactorMethodModel from '../../../models/UserTwoFactorMethod';
import { GraphQLTwoFactorMethodEnum } from '../enum/TwoFactorMethodEnum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

export const UserTwoFactorMethod = new GraphQLObjectType({
  name: 'UserTwoFactorMethod',
  description: 'User two factor authentication method',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.USER_TWO_FACTOR_METHOD),
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
