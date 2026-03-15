import { GraphQLEnumType } from 'graphql';

import { ContributionAccountingCategoryRuleOperator } from '../../../lib/accounting/categorization/types';

export const GraphQLContributionAccountingCategoryRuleOperator = new GraphQLEnumType({
  name: 'ContributionAccountingCategoryRuleOperator',
  description: 'The operator of the predicate',
  values: Object.entries(ContributionAccountingCategoryRuleOperator).reduce((values, [key, value]) => {
    return { ...values, [key]: { value } };
  }, {}),
});
