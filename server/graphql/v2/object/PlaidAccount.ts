import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { AccountType } from 'plaid';

const PlaidAccountType = new GraphQLEnumType({
  name: 'PlaidAccountType',
  values: () =>
    Object.fromEntries(Object.entries(AccountType).map(([name, type]) => [type, { value: type, description: name }])),
});

export const GraphQLPlaidAccount = new GraphQLObjectType({
  name: 'PlaidAccount',
  fields: () => ({
    accountId: { type: new GraphQLNonNull(GraphQLString) },
    mask: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    officialName: { type: new GraphQLNonNull(GraphQLString) },
    subtype: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(PlaidAccountType) },
  }),
});
