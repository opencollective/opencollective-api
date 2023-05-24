import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import AgreementModel from '../../../models/Agreement';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';
import { FileInfo } from '../interface/FileInfo';

import { Host } from './Host';

export const Agreement = new GraphQLObjectType<AgreementModel, express.Request>({
  name: 'Agreement',
  description: 'An agreement',
  fields: () => ({
    id: { type: GraphQLString, resolve: getIdEncodeResolver(IDENTIFIER_TYPES.AGREEMENT) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    createdBy: {
      type: new GraphQLNonNull(Account),
      async resolve(agreement, _, req) {
        const user = agreement.User || (await req.loaders.User.byId.load(agreement.UserId));
        if (user && user.CollectiveId) {
          return user.Collective || (await req.loaders.Collective.byId.load(user.CollectiveId));
        }
      },
    },
    account: {
      type: new GraphQLNonNull(Account),
      async resolve(agreement, _, req) {
        return agreement.Collective || (await req.loaders.Collective.byId.load(agreement.CollectiveId));
      },
    },
    host: {
      type: new GraphQLNonNull(Host),
      async resolve(agreement, _, req) {
        return agreement.Host || (await req.loaders.Collective.byId.load(agreement.HostCollectiveId));
      },
    },
    expiresAt: {
      type: GraphQLDateTime,
    },
    attachment: {
      type: FileInfo,
      async resolve(agreement, _, req) {
        if (agreement.UploadedFileId) {
          return req.loaders.UploadedFile.byId.load(agreement.UploadedFileId);
        }
      },
    },
  }),
});
