import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

import ExportRequest from '../../../models/ExportRequest';
import { GraphQLExportRequestStatus } from '../enum/ExportRequestStatus';
import { GraphQLExportRequestType } from '../enum/ExportRequestType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLFileInfo } from '../interface/FileInfo';

import { GraphQLIndividual } from './Individual';

export const GraphQLExportRequest = new GraphQLObjectType({
  name: 'ExportRequest',
  description: 'An export request',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'Unique identifier for this export request',
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPORT_REQUEST),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${ExportRequest.nanoIdPrefix}_xxxxxxxx)`,
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Legacy numeric ID of this export request',
      deprecationReason: '2026-02-25: use publicId',
      resolve(exportRequest: ExportRequest) {
        return exportRequest.id;
      },
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The name of the export request',
    },
    type: {
      type: new GraphQLNonNull(GraphQLExportRequestType),
      description: 'The type of export request',
    },
    status: {
      type: new GraphQLNonNull(GraphQLExportRequestStatus),
      description: 'The status of the export request',
    },
    parameters: {
      type: GraphQLJSON,
      description: 'The parameters of the export request',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The account that requested this export',
      resolve(exportRequest: ExportRequest, _, req) {
        return req.loaders.Collective.byId.load(exportRequest.CollectiveId);
      },
    },
    createdBy: {
      type: GraphQLIndividual,
      description: 'The user who created this export request',
      async resolve(exportRequest: ExportRequest, _, req) {
        if (!exportRequest.CreatedByUserId) {
          return null;
        }

        const user = await req.loaders.User.byId.load(exportRequest.CreatedByUserId);
        if (user?.CollectiveId) {
          const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
          if (collective && !collective.isIncognito) {
            return collective;
          }
        }
        return null;
      },
    },
    file: {
      type: GraphQLFileInfo,
      description: 'The exported file (if completed)',
      async resolve(exportRequest: ExportRequest, _, req) {
        if (exportRequest.UploadedFileId) {
          return req.loaders.UploadedFile.byId.load(exportRequest.UploadedFileId);
        }
        return null;
      },
    },
    progress: {
      type: GraphQLInt,
      description: 'The progress of the export request (0-100)',
      resolve(exportRequest: ExportRequest) {
        return exportRequest.data?.progress ?? null;
      },
    },
    error: {
      type: GraphQLString,
      description: 'The error message if the export request failed',
      resolve(exportRequest: ExportRequest) {
        return exportRequest.data?.error ?? null;
      },
    },
    willRetry: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether a failed export request will be retried automatically',
      resolve(exportRequest: ExportRequest) {
        return exportRequest.data?.shouldRetry === true;
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time the export request was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time the export request was last updated',
    },
    expiresAt: {
      type: GraphQLDateTime,
      description: 'The time when the export will expire',
    },
  }),
});
