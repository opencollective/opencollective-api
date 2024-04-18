import { GraphQLInputObjectType } from 'graphql';
import { Op } from 'sequelize';

import { AmountInputType, getValueInCentsFromAmountInput, GraphQLAmountInput } from './AmountInput';

export type AmountRangeInputType = {
  gte?: AmountInputType;
  lte?: AmountInputType;
};

export const GraphQLAmountRangeInput = new GraphQLInputObjectType({
  name: 'AmountRangeInput',
  description: 'Input type for an amount range with the value and currency',
  fields: () => ({
    gte: {
      type: GraphQLAmountInput,
      description: 'The minimum amount (inclusive)',
    },
    lte: {
      type: GraphQLAmountInput,
      description: 'The maximum amount (inclusive)',
    },
  }),
});

export const getAmountRangeValueAndOperator = (args: AmountRangeInputType) => {
  const operator = args.gte && args.lte ? Op.between : args.gte ? Op.gte : Op.lte;
  const value =
    operator === Op.between
      ? [getValueInCentsFromAmountInput(args.gte), getValueInCentsFromAmountInput(args.lte)]
      : (args.gte && getValueInCentsFromAmountInput(args.gte)) ||
        (args.lte && getValueInCentsFromAmountInput(args.lte));
  return { operator, value };
};
