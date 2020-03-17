import { GraphQLEnumType } from 'graphql';
import { Service } from '../../../constants/connected_account';

export const ConnectedAccountService = new GraphQLEnumType({
  name: 'ConnectedAccountService',
  description: 'All supported services a user can connect with',
  values: Object.values(Service).reduce((values, key) => ({ ...values, [key]: { value: key } }), {}),
});
