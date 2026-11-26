import type express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import type { FiscalHostNoteLevel } from '../../../models/FiscalHostNote';
import { GraphQLFiscalHostNoteType } from '../enum/FiscalHostNoteType';
import { GraphQLAccount } from '../interface/Account';

export interface FiscalHostNoteData {
  type: FiscalHostNoteLevel;
  note: string;
  updatedAt?: Date | string;
  UpdatedByUserId?: number | null;
}

export const GraphQLFiscalHostNote = new GraphQLObjectType<FiscalHostNoteData, express.Request>({
  name: 'FiscalHostNote',
  description: 'A host-private note about an account, set by a fiscal host admin',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLFiscalHostNoteType),
      description: 'The gravity of the note',
    },
    note: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The note content, as sanitized HTML',
    },
    updatedAt: {
      type: GraphQLDateTime,
      description: 'When the note was last updated',
    },
    updatedBy: {
      type: GraphQLAccount,
      description: 'The user who last updated the note',
      async resolve(note, _, req) {
        if (!note.UpdatedByUserId) {
          return null;
        }

        const user = await req.loaders.User.byId.load(note.UpdatedByUserId);
        if (user?.CollectiveId) {
          return user.collective || (await req.loaders.Collective.byId.load(user.CollectiveId));
        }
      },
    },
  }),
});
