import {
  GraphQLBoolean,
  GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDate } from 'graphql-scalars';

import { ExpenseOCRParseResult } from '../../../lib/ocr/ExpenseOCRService';
import { GraphQLStrictPercentage } from '../scalar/StrictPercentage';

import { GraphQLAmount } from './Amount';

export type ParseUploadedFileResult = {
  success: boolean;
  message?: string;
  expense?: ExpenseOCRParseResult;
};

const GraphQLExpenseItemParsedFileInfo = new GraphQLObjectType({
  name: 'ExpenseItemParsedFileInfo',
  fields: (): Record<
    keyof ParseUploadedFileResult['expense']['items'][0],
    GraphQLFieldConfig<any, Express.Request>
  > => ({
    description: { type: GraphQLString },
    amount: { type: GraphQLAmount },
    incurredAt: { type: GraphQLDate },
    url: { type: GraphQLString },
  }),
});

const GraphQLExpenseParsedFileInfo = new GraphQLObjectType({
  name: 'ExpenseParsedFileInfo',
  fields: (): Record<
    keyof Omit<ParseUploadedFileResult['expense'], 'raw'>,
    GraphQLFieldConfig<any, Express.Request>
  > => ({
    confidence: { type: GraphQLStrictPercentage },
    description: { type: GraphQLString },
    amount: { type: GraphQLAmount },
    date: { type: GraphQLDate },
    items: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLExpenseItemParsedFileInfo))),
    },
  }),
});

export const GraphQLParseUploadedFileResult = new GraphQLObjectType({
  name: 'ParseUploadedFileResult',
  fields: (): Record<keyof ParseUploadedFileResult, GraphQLFieldConfig<any, any>> => ({
    success: {
      description: 'Whether the parsing was successful',
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    message: {
      description:
        'A message describing the parsing result, usually an error message (if parsing failed) or some warnings',
      type: GraphQLString,
    },
    expense: {
      description: 'The parsed expense information',
      type: GraphQLExpenseParsedFileInfo,
    },
  }),
});
