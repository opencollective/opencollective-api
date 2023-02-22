import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import type { FileUpload } from 'graphql-upload/Upload.js';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { UploadedFile } from '../../../models';
import AgreementModel from '../../../models/Agreement';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { fetchAgreementWithReference, GraphQLAgreementReferenceInput } from '../input/AgreementReferenceInput';
import { GraphQLAgreement } from '../object/Agreement';

export default {
  addAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
    description: 'Add an agreement for the given host account. Scope: "host".',
    args: {
      title: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'Agreement title.',
      },
      expiresAt: {
        type: GraphQLDateTime,
        description: 'Optional date in which this agreement expires.',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Host where the agreement will be created.',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account that is a party in this agreement',
      },
      attachment: {
        type: GraphQLUpload,
        description: 'Agreement attachment',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, {
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can create agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      const account = await fetchAccountWithReference(args.account, {
        throwIfMissing: true,
      });

      const attachment: Promise<FileUpload> = args.attachment;

      let uploadedFile;
      if (attachment) {
        uploadedFile = await UploadedFile.uploadGraphQl(await attachment, 'AGREEMENT_ATTACHMENT', req.remoteUser);
      }

      const agreement = await AgreementModel.create({
        title: args.title,
        expiresAt: args.expiresAt,
        HostCollectiveId: host.id,
        CollectiveId: account.id,
        UserId: req.remoteUser.id,
        UploadedFileId: uploadedFile?.id,
      });

      return agreement;
    },
  },
  editAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
    description: 'Edit an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(GraphQLAgreementReferenceInput),
        description: 'Agreement to update.',
      },
      title: {
        type: GraphQLNonEmptyString,
        description: 'Updated agreement title',
      },
      expiresAt: {
        type: GraphQLDateTime,
        description: 'Optional date in which this agreement expires.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const agreement = await fetchAgreementWithReference(args.agreement, { throwIfMissing: true });
      const host = await agreement.getHost();

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can edit agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      const toUpdate: Parameters<AgreementModel['update']>[0] = {};

      if (args.title) {
        toUpdate.title = args.title;
      }

      if (args.expiresAt) {
        toUpdate.expiresAt = args.expiresAt;
      }

      return agreement.update(toUpdate);
    },
  },
  deleteAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
    description: 'Delete an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(GraphQLAgreementReferenceInput),
        description: 'Agreement to delete.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const agreement = await fetchAgreementWithReference(args.agreement, { throwIfMissing: true });
      const host = await agreement.getHost();

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can delete agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      await agreement.destroy();
      return agreement;
    },
  },
};
