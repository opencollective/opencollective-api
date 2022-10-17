import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Level, Scope } from '../../../lib/security/check';

export const SecurityCheckScope = new GraphQLEnumType({
  name: 'SecurityCheckScope',
  description: 'All supported SecurityCheck scopes',
  values: Object.values(Scope).reduce(
    (values, key) => ({
      ...values,
      [key]: { value: key },
    }),
    {},
  ),
});

export const SecurityCheckLevel = new GraphQLEnumType({
  name: 'SecurityCheckLevel',
  description: 'All supported SecurityCheck levels',
  values: Object.values(Level).reduce(
    (values, key) => ({
      ...values,
      [key]: { value: key },
    }),
    {},
  ),
});

export const SecurityCheck = new GraphQLObjectType({
  name: 'SecurityCheck',
  fields: () => ({
    scope: {
      type: new GraphQLNonNull(SecurityCheckScope),
      description: 'The SecurityCheck scope',
    },
    level: {
      type: new GraphQLNonNull(SecurityCheckLevel),
      description: 'The SecurityCheck level',
    },
    message: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'SecurityCheck description message',
    },
    details: {
      type: GraphQLString,
      description: 'SecurityCheck details',
    },
  }),
});
