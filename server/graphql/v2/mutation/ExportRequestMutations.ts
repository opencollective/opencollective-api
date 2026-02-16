import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { parseS3Url, permanentlyDeleteFileFromS3 } from '../../../lib/awsS3';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { reportErrorToSentry } from '../../../lib/sentry';
import ExportRequest, { ExportRequestStatus } from '../../../models/ExportRequest';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { GraphQLExportRequestCreateInput } from '../input/ExportRequestCreateInput';
import {
  fetchExportRequestWithReference,
  GraphQLExportRequestReferenceInput,
} from '../input/ExportRequestReferenceInput';
import { GraphQLExportRequest } from '../object/ExportRequest';

const exportRequestMutations = {
  createExportRequest: {
    type: new GraphQLNonNull(GraphQLExportRequest),
    description: 'Create a new export request. Scope: "account".',
    args: {
      exportRequest: {
        type: new GraphQLNonNull(GraphQLExportRequestCreateInput),
        description: 'The export request to create',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExportRequest> {
      checkRemoteUserCanUseAccount(req);

      // Rate limit
      const rateLimitKey = `create_export_request_${req.remoteUser.id}`;
      const rateLimit = new RateLimit(rateLimitKey, 10, ONE_HOUR_IN_SECONDS, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      const { exportRequest: input } = args;

      // Fetch account and check permissions
      const account = await fetchAccountWithReference(input.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You do not have permission to create export requests for this account');
      }

      // Create the export request
      const exportRequest = await ExportRequest.create({
        CollectiveId: account.id,
        CreatedByUserId: req.remoteUser.id,
        name: input.name,
        type: input.type,
        status: ExportRequestStatus.ENQUEUED,
        ...(input.parameters && { parameters: input.parameters }),
      });

      return exportRequest;
    },
  },

  editExportRequest: {
    type: new GraphQLNonNull(GraphQLExportRequest),
    description: 'Edit an existing export request. Scope: "account".',
    args: {
      exportRequest: {
        type: new GraphQLNonNull(GraphQLExportRequestReferenceInput),
        description: 'Reference to the export request to edit',
      },
      name: {
        type: GraphQLNonEmptyString,
        description: 'The new name for the export request',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExportRequest> {
      checkRemoteUserCanUseAccount(req);

      // Fetch the export request
      const exportRequest = await fetchExportRequestWithReference(args.exportRequest, { throwIfMissing: true });

      // Check permissions - user must be admin of the account
      const account = await exportRequest.getCollective();
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You do not have permission to edit this export request');
      }

      // Build update object with only provided fields
      const updateData: Partial<ExportRequest> = {};
      if (args.name !== undefined) {
        updateData.name = args.name;
      }

      // Update the export request
      if (Object.keys(updateData).length > 0) {
        await exportRequest.update(updateData);
      }

      return exportRequest;
    },
  },

  removeExportRequest: {
    type: new GraphQLNonNull(GraphQLExportRequest),
    description: 'Remove an existing export request. Scope: "account".',
    args: {
      exportRequest: {
        type: new GraphQLNonNull(GraphQLExportRequestReferenceInput),
        description: 'Reference to the export request to remove',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExportRequest> {
      checkRemoteUserCanUseAccount(req);

      // Fetch the export request
      const exportRequest = await fetchExportRequestWithReference(args.exportRequest, { throwIfMissing: true });

      // Check permissions - user must be admin of the account
      const account = await req.loaders.Collective.byId.load(exportRequest.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You do not have permission to remove this export request');
      }

      // Delete the uploaded file if it exists
      if (exportRequest.UploadedFileId) {
        const uploadedFile = await req.loaders.UploadedFile.byId.load(exportRequest.UploadedFileId);
        if (uploadedFile) {
          const { bucket, key } = parseS3Url(uploadedFile.getDataValue('url'));
          try {
            await permanentlyDeleteFileFromS3(bucket, key);
            await uploadedFile.destroy();
          } catch (error) {
            reportErrorToSentry(error);
            throw new Error('Failed to delete the uploaded file for this export request. Please contact support.');
          }
        }
      }

      // Delete the export request
      await exportRequest.destroy();

      return exportRequest;
    },
  },
};

export default exportRequestMutations;
