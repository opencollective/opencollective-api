import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSONObject } from 'graphql-scalars';

import { GraphQLAccountingCategoryAppliesTo } from '../enum/AccountingCategoryAppliesTo';
import { GraphQLAccountingCategoryKind } from '../enum/AccountingCategoryKind';
import { GraphQLExpenseType } from '../enum/ExpenseType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLHost } from './Host';

export const UncategorizedValue = '__uncategorized__';

export const GraphQLAccountingCategory = new GraphQLObjectType({
  name: 'AccountingCategory',
  description: 'Fields for an accounting category',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNTING_CATEGORY),
    },
    code: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The code of the accounting category',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The technical name of the accounting category',
    },
    friendlyName: {
      type: GraphQLString,
      description: 'A friendly name for non-accountants (i.e. expense submitters and collective admins)',
    },
    hostOnly: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this category is only meant for the host admins',
    },
    instructions: {
      type: GraphQLString,
      description: 'Instructions for the expense submitters',
    },
    account: {
      type: new GraphQLNonNull(GraphQLHost),
      description: 'The account this category belongs to',
      resolve: ({ CollectiveId }, _, req) => req.loaders.Collective.byId.load(CollectiveId),
    },
    expensesTypes: {
      type: new GraphQLList(GraphQLExpenseType),
      description: 'If meant for expenses, the types of expenses this category applies to',
    },
    kind: {
      type: GraphQLAccountingCategoryKind,
      description: 'The kind of transactions this category applies to',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time of creation of this accounting category',
    },
    appliesTo: {
      type: GraphQLAccountingCategoryAppliesTo,
      description: 'If the category is applicable to the Host or Hosted Collectives',
    },
  }),
});

export const GraphQLContributionAccountingCategoryRule = new GraphQLObjectType({
  name: 'ContributionAccountingCategoryRule',
  description: 'A rule for categorizing contributions',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.CONTRIBUTION_ACCOUNTING_CATEGORY_RULE),
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
    },
    enabled: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    predicates: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLJSONObject))),
    },
    accountingCategory: {
      type: new GraphQLNonNull(GraphQLAccountingCategory),
      resolve: ({ AccountingCategoryId }, _, req) => req.loaders.AccountingCategory.byId.load(AccountingCategoryId),
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
  },
});
