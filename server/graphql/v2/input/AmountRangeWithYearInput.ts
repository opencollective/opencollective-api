import { GraphQLInputObjectType, GraphQLInt } from 'graphql';

import { AmountRangeInputType, GraphQLAmountRangeInput } from './AmountRangeInput';

export type AmountRangeWithYearInputType = AmountRangeInputType & {
  year?: number;
};

export const GraphQLAmountRangeWithYearInput = new GraphQLInputObjectType({
  name: 'AmountRangeWithYearInput',
  description: 'Input type for an amount range, optionally restricted to a calendar year',
  fields: () => ({
    ...GraphQLAmountRangeInput.getFields(),
    year: {
      type: GraphQLInt,
      description: 'Only consider the amounts of this calendar year (UTC). Defaults to all time.',
    },
  }),
});
