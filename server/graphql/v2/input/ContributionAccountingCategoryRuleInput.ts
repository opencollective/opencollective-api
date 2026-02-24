import { GraphQLBoolean, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLAccountingCategoryReferenceInput } from './AccountingCategoryInput';
import { GraphQLContributionAccountingCategoryRulePredicateInput } from './ContributionAccountingCategoryRulePredicateInput';

export const GraphQLContributionAccountingCategoryRuleInput = new GraphQLInputObjectType({
  name: 'ContributionAccountingCategoryRuleInput',
  description: 'Input for creating or updating a contribution accounting category rule',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The ID of the contribution accounting category rule to edit',
    },
    accountingCategory: {
      type: new GraphQLNonNull(GraphQLAccountingCategoryReferenceInput),
      description: 'The accounting category to apply the rule to',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The name of the rule',
    },
    enabled: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the rule is enabled',
    },
    predicates: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(GraphQLContributionAccountingCategoryRulePredicateInput)),
      ),
      description: 'The predicates of the rule',
    },
  },
});
