import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import * as ExpenseLib from '../../common/expenses';

export const Permission = new GraphQLObjectType({
  name: 'Permission',
  fields: () => ({
    allowed: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: GraphQLString },
    reasonDetails: { type: GraphQLJSON },
  }),
});

export type PermissionFields = { allowed: boolean; reason?: string };

export const parsePermissionFromEvaluator =
  (fn: ExpenseLib.ExpensePermissionEvaluator) =>
  (expense, _, req: express.Request): Promise<PermissionFields> => {
    return fn(req, expense, { throw: true })
      .then(allowed => ({ allowed }))
      .catch(error => ({
        allowed: false,
        reason: error?.extensions?.code,
        reasonDetails: error?.extensions?.reasonDetails,
      }));
  };
