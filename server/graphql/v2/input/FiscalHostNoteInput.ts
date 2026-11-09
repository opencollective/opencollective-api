import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLFiscalHostNoteType } from '../enum/FiscalHostNoteType';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLSetFiscalHostNoteInput = new GraphQLInputObjectType({
  name: 'SetFiscalHostNoteInput',
  fields: () => ({
    host: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The fiscal host the note belongs to',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account the note is about',
    },
    type: {
      type: new GraphQLNonNull(GraphQLFiscalHostNoteType),
      description: 'The gravity of the note',
    },
    note: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The note content, as rich text with links',
    },
  }),
});

export const GraphQLRemoveFiscalHostNoteInput = new GraphQLInputObjectType({
  name: 'RemoveFiscalHostNoteInput',
  fields: () => ({
    host: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The fiscal host the note belongs to',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account the note is about',
    },
  }),
});
