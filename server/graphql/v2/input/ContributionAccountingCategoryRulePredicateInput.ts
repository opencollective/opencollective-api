import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLContributionAccountingCategoryRuleOperator } from '../enum/ContributionAccountingCategoryRuleOperator';
import { GraphQLContributionAccountingCategoryRuleSubject } from '../enum/ContributionAccountingCategoryRuleSubject';

export const GraphQLContributionAccountingCategoryRulePredicateInput = new GraphQLInputObjectType({
  name: 'ContributionAccountingCategoryRulePredicateInput',
  description: 'Input for creating or updating a contribution accounting category rule predicate',
  fields: {
    subject: {
      type: new GraphQLNonNull(GraphQLContributionAccountingCategoryRuleSubject),
      description: 'The subject of the predicate',
    },
    operator: {
      type: new GraphQLNonNull(GraphQLContributionAccountingCategoryRuleOperator),
      description: 'The operator of the predicate',
    },
    value: {
      type: new GraphQLNonNull(GraphQLJSON),
      description: 'The value of the predicate',
    },
  },
});
