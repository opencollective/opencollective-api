import { GraphQLInputObjectType } from 'graphql';

import { Op, sequelize } from '../../../models';

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

export const getAmountRangeQuery = (args: AmountRangeInputType) => {
  const { operator, value } = getAmountRangeValueAndOperator(args);

  switch (operator) {
    case Op.between:
      return ` BETWEEN ${value[0]} AND ${value[1]}`;
    case Op.gte:
      return ` >= ${value}`;
    case Op.lte:
      return ` <= ${value}`;
  }
};

export const ACCOUNT_BALANCE_QUERY = sequelize.literal(
  '(SELECT COALESCE("CurrentCollectiveBalance"."netAmountInHostCurrency", 0) FROM "CurrentCollectiveBalance" WHERE "CurrentCollectiveBalance"."CollectiveId" = "Collective"."id")',
);

export const makeConsolidatedBalanceSubquery = (collectiveTableName: string) =>
  `(SELECT COALESCE(SUM(COALESCE("CurrentCollectiveBalance"."netAmountInHostCurrency", 0)), 0) FROM "CurrentCollectiveBalance" WHERE "CurrentCollectiveBalance"."CollectiveId" IN (SELECT id FROM "Collectives" WHERE "deletedAt" IS NULL AND "isActive" IS TRUE AND ("ParentCollectiveId" = ${collectiveTableName}."id" OR id = ${collectiveTableName}."id")))`;

export const ACCOUNT_CONSOLIDATED_BALANCE_QUERY = sequelize.literal(makeConsolidatedBalanceSubquery('"Collective"'));
