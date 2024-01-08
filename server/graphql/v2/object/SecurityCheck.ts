// ignore unused exports GraphQLSecurityCheckScope, GraphQLSecurityCheckLevel

import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Level, Scope } from '../../../lib/security/expense';

export const GraphQLSecurityCheckScope = new GraphQLEnumType({
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

export const GraphQLSecurityCheckLevel = new GraphQLEnumType({
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

export const GraphQLSecurityCheck = new GraphQLObjectType({
  name: 'SecurityCheck',
  fields: () => ({
    scope: {
      type: new GraphQLNonNull(GraphQLSecurityCheckScope),
      description: 'The SecurityCheck scope',
    },
    level: {
      type: new GraphQLNonNull(GraphQLSecurityCheckLevel),
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
