import { GraphQLEnumType } from 'graphql';

export const GraphQLFiscalHostNoteType = new GraphQLEnumType({
  name: 'FiscalHostNoteType',
  description: 'The gravity of a fiscal host note about an account',
  values: {
    WARNING: { value: 'WARNING' },
    INFO: { value: 'INFO' },
    POSITIVE: { value: 'POSITIVE' },
  },
});
