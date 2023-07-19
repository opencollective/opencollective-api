import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import AgreementModel from '../../../models/Agreement.js';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers.js';
import { GraphQLAccount } from '../interface/Account.js';
import { GraphQLFileInfo } from '../interface/FileInfo.js';

import { GraphQLHost } from './Host.js';

export const GraphQLAgreement = new GraphQLObjectType<AgreementModel, express.Request>({
  name: 'Agreement',
  description: 'An agreement',
  fields: () => ({
    id: { type: GraphQLString, resolve: getIdEncodeResolver(IDENTIFIER_TYPES.AGREEMENT) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    notes: {
      type: GraphQLString,
      description: 'Additional notes about the agreement for the host admins',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time of creation of this agreement',
    },
    createdBy: {
      type: GraphQLAccount,
      async resolve(agreement, _, req) {
        const user = agreement.User || (await req.loaders.User.byId.load(agreement.UserId));
        if (user && user.CollectiveId) {
          return user.Collective || (await req.loaders.Collective.byId.load(user.CollectiveId));
        }
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      async resolve(agreement, _, req) {
        return agreement.Collective || (await req.loaders.Collective.byId.load(agreement.CollectiveId));
      },
    },
    host: {
      type: new GraphQLNonNull(GraphQLHost),
      async resolve(agreement, _, req) {
        return agreement.Host || (await req.loaders.Collective.byId.load(agreement.HostCollectiveId));
      },
    },
    expiresAt: {
      type: GraphQLDateTime,
    },
    attachment: {
      type: GraphQLFileInfo,
      async resolve(agreement, _, req) {
        if (agreement.UploadedFileId) {
          return req.loaders.UploadedFile.byId.load(agreement.UploadedFileId);
        }
      },
    },
  }),
});
