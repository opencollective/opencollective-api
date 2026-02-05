import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import ExportRequest from '../../../models/ExportRequest';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden } from '../../errors';
import {
  fetchExportRequestWithReference,
  GraphQLExportRequestReferenceInput,
} from '../input/ExportRequestReferenceInput';
import { GraphQLExportRequest } from '../object/ExportRequest';

const ExportRequestQuery = {
  type: GraphQLExportRequest,
  args: {
    exportRequest: {
      type: new GraphQLNonNull(GraphQLExportRequestReferenceInput),
      description: 'Identifiers to retrieve the export request',
    },
    throwIfMissing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If true, an error will be returned if the export request is missing',
      defaultValue: true,
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<ExportRequest | null> {
    checkRemoteUserCanUseAccount(req);

    const exportRequest = await fetchExportRequestWithReference(args.exportRequest, {
      throwIfMissing: args.throwIfMissing,
    });

    if (!exportRequest) {
      return null;
    }

    // Fetch the account to check permissions
    const account = await req.loaders.Collective.byId.load(exportRequest.CollectiveId);
    if (!req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden('You do not have permission to view this export request');
    }

    return exportRequest;
  },
};

export default ExportRequestQuery;
