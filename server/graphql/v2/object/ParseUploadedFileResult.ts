import { GraphQLBoolean, GraphQLFieldConfig, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDate } from 'graphql-scalars';

import { GraphQLStrictPercentage } from '../scalar/StrictPercentage';

import { GraphQLAmount } from './Amount';

const GraphQLExpenseParsedFileInfo = new GraphQLObjectType({
  name: 'ExpenseParsedFileInfo',
  fields: () => ({
    description: { type: GraphQLString },
    amount: { type: GraphQLAmount },
    incurredAt: { type: GraphQLDate },
  }),
});

export type ParseUploadedFileResult = {
  success: boolean;
  message?: string;
  confidence?: number;
  expense?: {
    description: string;
    amount: { value: number; currency: string };
    incurredAt: Date;
  };
};

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
    confidence: {
      description: 'The confidence of the parsing result',
      type: GraphQLStrictPercentage,
    },
    expense: {
      description: 'The parsed expense information',
      type: GraphQLExpenseParsedFileInfo,
    },
  }),
});
