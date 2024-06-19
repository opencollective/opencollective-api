import { GraphQLEnumType } from 'graphql';

import { AccountingCategoryAppliesTo } from '../../../models/AccountingCategory';

export const GraphQLAccountingCategoryAppliesTo = new GraphQLEnumType({
  name: 'AccountingCategoryAppliesTo',
  values: Object.values(AccountingCategoryAppliesTo).reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});
