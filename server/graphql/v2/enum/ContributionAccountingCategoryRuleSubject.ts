import { GraphQLEnumType } from 'graphql';

import { ContributionAccountingCategoryRuleSubject } from '../../../lib/accounting/categorization/types';

export const GraphQLContributionAccountingCategoryRuleSubject = new GraphQLEnumType({
  name: 'ContributionAccountingCategoryRuleSubject',
  description: 'The subject of the predicate',
  values: Object.values(ContributionAccountingCategoryRuleSubject).reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});
