import { GraphQLEnumType } from 'graphql';

import { AccountingCategoryKindList } from '../../../models/AccountingCategory';

export const GraphQLAccountingCategoryKind = new GraphQLEnumType({
  name: 'AccountingCategoryKind',
  values: AccountingCategoryKindList.reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});
