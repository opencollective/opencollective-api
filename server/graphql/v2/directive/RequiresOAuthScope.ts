import { DirectiveLocation, GraphQLDirective, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

export const RequiresOAuthScopeDirective = new GraphQLDirective({
  name: 'requiresOAuthScope',
  description:
    'When called with an OAuth or personal token, the token must include all listed scopes. Session/cookie auth is unaffected.',
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    scopes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: 'Required OAuth scopes (e.g. transactions, expenses).',
    },
  },
});
